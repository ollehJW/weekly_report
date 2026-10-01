const parse = (iso) => new Date(`${iso}T12:00:00`);
const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const add = (date, count) => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
const monday = (date) => add(date, -((date.getDay() + 6) % 7));
const monthKey = (date) => iso(date).slice(0, 7);

// Each top-level period has the same width. Subcells are weekdays or four month buckets.
export function buildTimelineAxis(start, end, mode = 'day') {
  const first = parse(start), last = parse(end);
  const groups = [], cells = [], indices = new Map();
  const push = (key, label, dates, labels, hint = '') => {
    const startCol = cells.length;
    dates.forEach((date, index) => cells.push({ key: `${key}-${index}`, date: iso(date), label: labels[index], boundary: index === 0 }));
    groups.push({ key, label, hint, startCol, count: dates.length });
  };
  if (mode === 'week') {
    for (let date = monday(first); date <= last; date = add(date, 7)) {
      const dates = Array.from({ length: 5 }, (_, i) => add(date, i));
      const week = Math.floor((date.getDate() - 1) / 7) + 1;
      push(iso(date), `${date.getMonth() + 1}월 ${week}주차`, dates, ['월', '화', '수', '목', '금'], `${iso(date)} ~ ${iso(add(date, 4))}`);
      for (let i = 0; i < 7; i++) indices.set(iso(add(date, i)), cells.length - 5 + Math.min(i, 4));
    }
  } else if (mode === 'month') {
    for (let date = new Date(first.getFullYear(), first.getMonth(), 1, 12); date <= last; date = new Date(date.getFullYear(), date.getMonth() + 1, 1, 12)) {
      const base = cells.length;
      push(monthKey(date), `${date.getMonth() + 1}월`, [1, 8, 15, 22].map((d) => new Date(date.getFullYear(), date.getMonth(), d, 12)), ['1주차', '2주차', '3주차', '4주차'], `${date.getFullYear()}년 ${date.getMonth() + 1}월 · 1~7일 / 8~14일 / 15~21일 / 22일~말일`);
      for (let d = new Date(date); d.getMonth() === date.getMonth(); d = add(d, 1)) indices.set(iso(d), base + Math.min(3, Math.floor((d.getDate() - 1) / 7)));
    }
  } else {
    for (let date = new Date(first); date <= last; date = add(date, 1)) {
      if ([0, 6].includes(date.getDay())) continue;
      indices.set(iso(date), cells.length);
      push(iso(date), String(date.getDate()).padStart(2, '0'), [date], ['일', '월', '화', '수', '목', '금', '토'].slice(date.getDay(), date.getDay() + 1), iso(date));
    }
    // Weekend-only milestones still need a visible column.
    if (!cells.length) { indices.set(start, 0); push(start, String(first.getDate()).padStart(2, '0'), [first], ['일', '월', '화', '수', '목', '금', '토'].slice(first.getDay(), first.getDay() + 1), start); }
  }
  function indexFor(value, endBoundary = false) {
    if (indices.has(value)) return indices.get(value);
    const next = cells.findIndex((cell) => cell.date >= value);
    if (next < 0) return cells.length - 1;
    return Math.max(0, next - (endBoundary && cells[next].date !== value ? 1 : 0));
  }
  return { groups, cells, todayIndex: (today) => today < start || today > end ? -1 : indexFor(today), spanFor: (startDate, endDate) => {
    if (endDate < start || startDate > end) return null;
    const startCol = indexFor(startDate < start ? start : startDate);
    const endCol = indexFor(endDate > end ? end : endDate, true);
    return { startCol, colSpan: Math.max(1, endCol - startCol + 1) };
  } };
}
