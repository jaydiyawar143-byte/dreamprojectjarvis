export default function DashboardPage() {
  return (
    <div className="jarvis-dashboard-shell min-h-screen overflow-hidden bg-[#030812] text-sys-text">
      <div className="jarvis-noise" />
      <div className="jarvis-grid" />

      <div className="relative mx-auto max-w-[1500px] px-5 py-6 lg:px-8">
        <div className="jarvis-console">
          <header className="mb-6 flex items-center justify-between px-5 pt-5 text-[11px] uppercase tracking-[0.28em] text-sys-text/70">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-2.5 w-2.5 rounded-full bg-[#38d6ff] shadow-[0_0_18px_rgba(56,214,255,0.9)]" />
              <span>JARVIS // ONLINE</span>
            </div>
            <div className="flex items-center gap-6 text-sys-text/75">
              <span>03:56</span>
              <span className="flex items-center gap-2">
                <span className="block h-2 w-2 rounded-full bg-[#7ceaf7]" />
                92%
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px]">
                SECURE
              </span>
            </div>
          </header>

          <div className="grid gap-5 px-5 pb-5 xl:grid-cols-[260px_minmax(0,1fr)_280px]">
            <aside className="jarvis-panel min-h-[760px] p-4">
              <div className="mb-5 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-[0.28em] text-sys-text/60">agents</p>
                <span className="rounded-full border border-[#3ee0f2]/30 bg-[#3ee0f2]/10 px-2 py-1 text-[9px] text-[#9beeff]">
                  12 active
                </span>
              </div>

              <div className="space-y-3">
                {[
                  ["Strategy Core", "online", "94%"],
                  ["Meta Analyzer", "syncing", "87%"],
                  ["Knowledge Vault", "online", "99%"],
                  ["Growth Bot", "scanning", "81%"],
                ].map(([name, status, score]) => (
                  <div key={name} className="rounded-2xl border border-white/6 bg-white/[0.02] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-white/90">{name}</span>
                      <span className="text-[9px] uppercase tracking-[0.22em] text-[#9beeff]">{status}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-sys-text/60">
                      <span>confidence</span>
                      <span>{score}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#3ee0f2] via-[#7ceaf7] to-[#8d8bff]"
                        style={{ width: score }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-2xl border border-[#3ee0f2]/15 bg-[#0a1f2f]/80 p-3">
                <div className="mb-3 flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-sys-text/60">
                  <span>Queue</span>
                  <span className="text-[#9beeff]">3 pending</span>
                </div>
                <div className="space-y-2 text-sm text-sys-text/75">
                  <div className="flex justify-between"><span>Campaign review</span><span>12m</span></div>
                  <div className="flex justify-between"><span>Ops alert</span><span>4m</span></div>
                  <div className="flex justify-between"><span>Memory sync</span><span>1m</span></div>
                </div>
              </div>
            </aside>

            <main className="jarvis-panel overflow-hidden p-4">
              <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.26em] text-sys-text/60">
                <span>mission control</span>
                <span className="rounded-full border border-[#49dfae]/20 bg-[#49dfae]/10 px-2 py-1 text-[#9af3d0]">
                  AUTO MODE
                </span>
              </div>

              <div className="relative h-[560px] rounded-[28px] border border-[#2dd9ff]/20 bg-[radial-gradient(circle_at_center,_rgba(47,120,255,0.15),_rgba(10,18,30,0.96)_52%,_rgba(5,8,16,1)_100%)] p-5 shadow-[inset_0_0_40px_rgba(62,224,242,0.07)]">
                <div className="jarvis-ring" />
                <div className="jarvis-ring ring-two" />

                <div className="absolute inset-x-10 top-10 flex items-center justify-between text-[10px] uppercase tracking-[0.3em] text-sys-text/50">
                  <span>system</span>
                  <span>synced</span>
                  <span>signal</span>
                </div>

                <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center">
                  <div className="relative flex h-[250px] w-[250px] items-center justify-center rounded-full border border-[#3ee0f2]/35 bg-[radial-gradient(circle,_rgba(57,164,255,0.18),_rgba(9,19,32,0.5)_58%,_rgba(7,15,23,0.95)_100%)] shadow-[0_0_40px_rgba(62,224,242,0.28)]">
                    <div className="absolute inset-6 rounded-full border border-[#75ebff]/30" />
                    <div className="absolute inset-12 rounded-full border border-[#75ebff]/25" />
                    <div className="absolute inset-[26%] rounded-full bg-[radial-gradient(circle,_rgba(49,211,255,0.85),_rgba(30,102,196,0.9)_40%,_rgba(6,14,24,0.2)_100%)] shadow-[0_0_32px_rgba(62,224,242,0.8)]" />
                    <div className="absolute inset-[34%] rounded-full border border-white/20 bg-black/20" />
                  </div>
                  <div className="mt-5 text-center">
                    <div className="text-[11px] uppercase tracking-[0.38em] text-sys-text/55">AI INTELLIGENCE</div>
                    <div className="mt-3 text-4xl font-light tracking-[0.12em] text-white">96.8%</div>
                  </div>
                </div>

                <div className="absolute left-8 top-24 rounded-xl border border-white/8 bg-[#091824]/70 px-3 py-2 text-[10px] uppercase tracking-[0.22em] text-sys-text/70">
                  live ops <span className="ml-2 text-[#9beeff]">63</span>
                </div>
                <div className="absolute right-8 top-24 rounded-xl border border-white/8 bg-[#091824]/70 px-3 py-2 text-[10px] uppercase tracking-[0.22em] text-sys-text/70">
                  confidence <span className="ml-2 text-[#9beeff]">99.2</span>
                </div>
                <div className="absolute bottom-8 left-8 rounded-xl border border-white/8 bg-[#091824]/70 p-3">
                  <div className="text-[10px] uppercase tracking-[0.26em] text-sys-text/60">pipeline</div>
                  <div className="mt-2 text-xl text-white">$1.4M</div>
                </div>
                <div className="absolute bottom-8 right-8 rounded-xl border border-white/8 bg-[#091824]/70 p-3">
                  <div className="text-[10px] uppercase tracking-[0.26em] text-sys-text/60">throughput</div>
                  <div className="mt-2 text-xl text-[#8feaff]">+18.4%</div>
                </div>
              </div>
            </main>

            <aside className="jarvis-panel min-h-[760px] p-4">
              <div className="mb-5 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-[0.28em] text-sys-text/60">insights</p>
                <span className="text-[9px] uppercase tracking-[0.2em] text-[#9beeff]">updated 2m</span>
              </div>

              <div className="space-y-4">
                {[
                  ["ROAS", "+31.8%", "above target"],
                  ["CPL", "-$0.42", "optimized"],
                  ["Intent", "83%", "strong"],
                ].map(([label, value, note]) => (
                  <div key={label} className="rounded-2xl border border-white/6 bg-white/[0.02] p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-[0.26em] text-sys-text/60">{label}</span>
                      <span className="text-[#9beeff]">{value}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                      <div className="h-full w-2/3 rounded-full bg-gradient-to-r from-[#3ee0f2] to-[#8d8bff]" />
                    </div>
                    <div className="mt-2 text-xs text-sys-text/60">{note}</div>
                  </div>
                ))}
              </div>

              <div className="mt-6 rounded-2xl border border-white/6 bg-white/[0.02] p-3">
                <div className="mb-3 text-[10px] uppercase tracking-[0.28em] text-sys-text/60">recommendations</div>
                <ul className="space-y-3 text-sm text-sys-text/80">
                  <li className="rounded-xl border border-[#3ee0f2]/15 bg-[#0a1b2e]/75 p-2.5">Increase spend on high-converting keywords</li>
                  <li className="rounded-xl border border-[#3ee0f2]/15 bg-[#0a1b2e]/75 p-2.5">Retarget warm audiences with AI summary</li>
                  <li className="rounded-xl border border-[#3ee0f2]/15 bg-[#0a1b2e]/75 p-2.5">Rebalance budget across message variants</li>
                </ul>
              </div>
            </aside>
          </div>

          <div className="mt-5 grid gap-5 px-5 pb-5 lg:grid-cols-[1.5fr_1fr]">
            <div className="jarvis-panel p-4">
              <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.26em] text-sys-text/60">
                <span>performance</span>
                <span className="text-[#9beeff]">last 30 days</span>
              </div>
              <div className="flex h-32 items-end gap-2">
                {[42, 58, 46, 70, 62, 82, 68, 94, 74, 88, 90, 100].map((height, idx) => (
                  <div key={idx} className="flex-1">
                    <div
                      className="w-full rounded-t-lg bg-gradient-to-t from-[#1b7ef0] via-[#39d5ff] to-[#8df5ff] shadow-[0_0_18px_rgba(62,224,242,0.3)]"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="jarvis-panel p-4">
              <div className="mb-4 flex items-center justify-between text-[10px] uppercase tracking-[0.26em] text-sys-text/60">
                <span>system</span>
                <span className="text-[#9beeff]">healthy</span>
              </div>
              <div className="space-y-3 text-sm text-sys-text/80">
                <div className="flex items-center justify-between"><span>Latency</span><span className="text-[#9beeff]">18ms</span></div>
                <div className="flex items-center justify-between"><span>Memory</span><span className="text-[#9beeff]">74%</span></div>
                <div className="flex items-center justify-between"><span>Model uptime</span><span className="text-[#9beeff]">99.98%</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
