// ---------------------------------------------------------------------------
// Phase 19.6 — nothing is acted on unless it is exactly what the server signed,
// for this device, for this grant, now, and for the first time.
// ---------------------------------------------------------------------------

using System.Text.Json;
using Jarvis.DesktopAgent.Core;
using Xunit;

namespace Jarvis.DesktopAgent.Core.Tests;

public class ParserTests
{
    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static CommandEnvelope Valid => Commands.Sign(new ClickParams(10, 20, "left"), Guid.NewGuid().ToString("D"), 1_000);

    private static string Mutate(Func<Dictionary<string, object?>, Dictionary<string, object?>> change)
    {
        var fields = JsonSerializer.Deserialize<Dictionary<string, object?>>(Commands.Json(Valid))!;
        return JsonSerializer.Serialize(change(fields));
    }

    [Fact]
    public void Parses_each_of_the_three_shapes()
    {
        var grant = Guid.NewGuid().ToString("D");
        foreach (var parameters in new CommandParams[] { new ClickParams(0, 100_000, "middle"), new KeyParams("escape"), new TypeParams("héllo 👋") })
        {
            var envelope = Commands.Sign(parameters, grant, 5_000);
            Assert.Equal(envelope, MessageParser.ParseCommand(Parse(Commands.Json(envelope))));
        }
    }

    [Theory]
    [InlineData("an unknown field", """{"extra":1}""")]
    [InlineData("an unknown action", """{"action":"desktop.screen.read"}""")]
    [InlineData("a shell action", """{"action":"desktop.shell.run"}""")]
    [InlineData("a negative coordinate", """{"params":{"x":-1,"y":0,"button":"left"}}""")]
    [InlineData("a coordinate past the limit", """{"params":{"x":100001,"y":0,"button":"left"}}""")]
    [InlineData("a fractional coordinate", """{"params":{"x":1.5,"y":0,"button":"left"}}""")]
    [InlineData("an unknown button", """{"params":{"x":1,"y":0,"button":"x1"}}""")]
    [InlineData("an extra parameter", """{"params":{"x":1,"y":0,"button":"left","double":true}}""")]
    [InlineData("a string where a number goes", """{"issuedAt":"1000"}""")]
    [InlineData("a string where a boolean goes", """{"requiresHello":"false"}""")]
    [InlineData("an uppercase id", """{"commandId":"8F14E45F-CEEA-467A-9AD1-0E9A5B0B7D2C"}""")]
    public void Refuses_a_command_that_is_not_exactly_a_declared_shape(string label, string patch)
    {
        _ = label;
        var json = Mutate(fields =>
        {
            foreach (var property in JsonDocument.Parse(patch).RootElement.EnumerateObject())
                fields[property.Name] = property.Value.Clone();
            return fields;
        });
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParseCommand(Parse(json)));
    }

    [Fact]
    public void Refuses_a_missing_field_and_a_duplicated_one()
    {
        var missing = Mutate(fields =>
        {
            fields.Remove("signature");
            return fields;
        });
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParseCommand(Parse(missing)));
        var json = Commands.Json(Valid);
        var duplicated = json.Insert(1, "\"grantId\":\"" + Guid.NewGuid().ToString("D") + "\",");
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParseCommand(Parse(duplicated)));
    }

    [Theory]
    [InlineData("line\nbreak")]
    [InlineData("tab\there")]
    [InlineData("bell\u0007")]
    [InlineData("c1\u0085")]
    [InlineData("separator\u2028")]
    public void Refuses_text_that_cannot_be_typed(string text)
    {
        var envelope = Commands.Sign(new TypeParams("ok"), Guid.NewGuid().ToString("D"), 1_000);
        var json = Commands.Json(envelope with { Params = new TypeParams(text) });
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParseCommand(Parse(json)));
        Assert.False(TypeableText.IsValid(text));
    }

    [Fact]
    public void Refuses_another_protocol_version_and_unknown_poll_fields()
    {
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParsePollResponse(Parse("""{"version":"jarvis-desktop/2","device":{"status":"active"},"grant":null,"command":null}""")));
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParsePollResponse(Parse("""{"version":"jarvis-desktop/1","device":{"status":"active"},"grant":null,"command":null,"screen":true}""")));
        Assert.Throws<ProtocolViolationException>(() => MessageParser.ParsePollResponse(Parse("""{"version":"jarvis-desktop/1","device":{"status":"revoked"},"grant":null,"command":null}""")));
        var ok = MessageParser.ParsePollResponse(Parse("""{"version":"jarvis-desktop/1","device":{"status":"pending"},"grant":null,"command":null}"""));
        Assert.Equal("pending", ok.DeviceStatus);
    }

    [Fact]
    public void Reads_only_known_error_codes()
    {
        Assert.Equal("DEVICE_REVOKED", MessageParser.ParseErrorCode(Parse(FakeServer.Error("DEVICE_REVOKED"))));
        Assert.Null(MessageParser.ParseErrorCode(Parse(FakeServer.Error("SOMETHING_ELSE"))));
        Assert.Null(MessageParser.ParseErrorCode(Parse("""{"version":"jarvis-desktop/1","error":{"code":"DEVICE_REVOKED","message":"x"}}""")));
    }
}

public sealed class VerifierTests : IDisposable
{
    private readonly TestClock clock = new();
    private readonly GrantManager grants;
    private readonly CommandVerifier verifier;
    private readonly LocalGrant grant;

    public VerifierTests()
    {
        grants = new GrantManager(clock);
        verifier = new CommandVerifier(Contract.ServerSpki, Commands.DeviceId, grants, clock);
        grant = grants.Prepare([ProtocolConstants.Click, ProtocolConstants.Type], 15, new string('a', 64));
        Assert.True(grants.Activate(grant, null));
    }

    public void Dispose() => grants.Dispose();

    private CommandEnvelope Click(long? issuedAt = null) => Commands.Sign(new ClickParams(5, 5, "left"), grant.GrantId, issuedAt ?? clock.NowMs);

    [Fact]
    public void Accepts_a_signed_command_for_this_device_and_grant()
    {
        Assert.True(verifier.Check(Click(), clock.NowMs).Accepted);
    }

    [Fact]
    public void Refuses_a_command_whose_parameters_were_changed_after_signing()
    {
        var tampered = Click() with { Params = new ClickParams(6, 5, "left") };
        Assert.Equal("INVALID_COMMAND", verifier.Check(tampered, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Refuses_a_command_signed_by_any_other_key()
    {
        using var other = new TestDeviceKey();
        var unsigned = Click() with { Signature = "" };
        var forged = unsigned with { Signature = Signatures.Sign(other, Canonical.Command(unsigned)) };
        Assert.Equal("INVALID_COMMAND", verifier.Check(forged, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Refuses_a_command_for_another_device()
    {
        var command = Commands.Sign(new ClickParams(5, 5, "left"), grant.GrantId, clock.NowMs, deviceId: Guid.NewGuid().ToString("D"));
        Assert.Equal("INVALID_COMMAND", verifier.Check(command, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Refuses_typing_that_does_not_require_hello_even_when_signed()
    {
        var command = Commands.Sign(new TypeParams("x"), grant.GrantId, clock.NowMs, requiresHello: false);
        Assert.Equal("INVALID_COMMAND", verifier.Check(command, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Refuses_a_command_that_would_live_longer_than_thirty_seconds()
    {
        var command = Commands.Sign(new ClickParams(5, 5, "left"), grant.GrantId, clock.NowMs, lifetime: 30_001);
        Assert.Equal("INVALID_COMMAND", verifier.Check(command, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Refuses_an_expired_command_by_the_server_clock_beyond_the_skew()
    {
        var command = Click(clock.NowMs - 30_000 - 60_001);
        Assert.Equal("COMMAND_EXPIRED", verifier.Check(command, clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Counts_a_commands_life_from_its_arrival_here_too()
    {
        var command = Click();
        var arrived = clock.NowMs;
        clock.Advance(30_001);
        Assert.Equal("COMMAND_EXPIRED", verifier.Check(command, arrived).Refusal?.Code);
    }

    [Fact]
    public void Refuses_a_command_issued_in_the_future_beyond_the_skew()
    {
        Assert.Equal("COMMAND_EXPIRED", verifier.Check(Click(clock.NowMs + 60_001), clock.NowMs).Refusal?.Code);
    }

    [Fact]
    public void Ignores_a_replay_entirely_and_never_answers_it()
    {
        var command = Click();
        Assert.True(verifier.Check(command, clock.NowMs).Accepted);
        var again = verifier.Check(command, clock.NowMs);
        Assert.False(again.Accepted);
        Assert.False(again.Report);
    }

    [Fact]
    public void Refuses_without_the_grant_or_outside_its_scope()
    {
        Assert.Equal("GRANT_INACTIVE", verifier.Check(Commands.Sign(new KeyParams("enter"), grant.GrantId, clock.NowMs), clock.NowMs).Refusal?.Code);
        Assert.Equal("GRANT_INACTIVE", verifier.Check(Commands.Sign(new ClickParams(1, 1, "left"), Guid.NewGuid().ToString("D"), clock.NowMs), clock.NowMs).Refusal?.Code);
        grants.End("user");
        Assert.Equal("GRANT_INACTIVE", verifier.Check(Click(), clock.NowMs).Refusal?.Code);
    }
}
