// ---------------------------------------------------------------------------
// Inline emphasis renders; markdown syntax does not reach the user.
//
// The bug: `{msg.content}` in a pre-wrap paragraph meant a capability answer
// arrived on screen as "- **Business and advertising**: I can ...", asterisks
// included. The prompt was told twice, with examples, to emit plain text and
// kept emitting `**` on every run — so this is fixed in the renderer instead.
//
// The second describe block is the one that must never regress: this component
// exists downstream of model output, and the reason the original code was a
// bare text node was to keep that output away from any HTML path. Rendering
// emphasis must not reintroduce one.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageText } from "@/components/message-text";

describe("inline markdown is rendered, not shown", () => {
  it("renders bold as an element and drops the asterisks", () => {
    render(<MessageText content="- **Business and advertising**: I can help." />);

    expect(screen.getByText("Business and advertising").tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
  });

  it("renders italic and inline code", () => {
    render(<MessageText content="that is *important* and `act_123` is an id" />);

    expect(screen.getByText("important").tagName).toBe("EM");
    expect(screen.getByText("act_123").tagName).toBe("CODE");
  });

  it("strips a heading marker, which has no block rendering here", () => {
    render(<MessageText content="### Summary" />);

    expect(document.body.textContent).toBe("Summary");
  });

  it("leaves ordinary prose completely untouched", () => {
    render(<MessageText content="Your CPA is 12 rupees and spend was 2 * 600." />);

    expect(document.body.textContent).toBe("Your CPA is 12 rupees and spend was 2 * 600.");
  });

  it("preserves line structure", () => {
    render(<MessageText content={"first line\nsecond line"} />);

    expect(document.body.textContent).toContain("first line");
    expect(document.body.textContent).toContain("second line");
  });

  it("does not treat an underscore inside a word as emphasis", () => {
    render(<MessageText content="the field is date_range_source here" />);

    expect(document.body.textContent).toBe("the field is date_range_source here");
  });
});

describe("model output still cannot become markup", () => {
  it("renders HTML in a message as text, never as elements", () => {
    render(<MessageText content={'<script>alert(1)</script> and <b>not bold</b>'} />);

    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(document.body.textContent).toContain("<script>alert(1)</script>");
    expect(document.body.textContent).toContain("<b>not bold</b>");
  });

  it("does not render a markdown link, which would be a model-authored href", () => {
    render(<MessageText content="see [the dashboard](https://evil.example/phish)" />);

    expect(document.querySelector("a")).toBeNull();
    expect(document.body.textContent).toContain("https://evil.example/phish");
  });

  it("renders bold containing HTML as literal text inside the element", () => {
    render(<MessageText content="**<img src=x onerror=alert(1)>**" />);

    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
