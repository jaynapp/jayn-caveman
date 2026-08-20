export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const render = (cells: readonly string[]) =>
    header
      .map((_, i) => (cells[i] ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [render(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(render)];
}
