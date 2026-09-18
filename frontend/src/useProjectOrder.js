import { useEffect, useRef, useState } from 'react';

const statusOf = (project) => project.status === 'done' ? 'done' : 'in_progress';
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export function useProjectOrder(projects, onSave) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState(null);
  const pointer = useRef(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pointer.current = null; }; }, []);

  function targetAt(x, y, project) {
    const column = document.elementFromPoint(x, y)?.closest('[data-project-order-status]');
    if (!column || column.dataset.projectOrderStatus !== statusOf(project)) return null;
    const cards = [...column.querySelectorAll('[data-project-order-card]')].filter((card) => card.dataset.projectOrderCard !== project.project_id);
    const grid = (column.querySelector('[data-project-order-list]') || column.querySelector('.project-card-list')).getBoundingClientRect();
    const next = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      const multiColumn = rect.width < grid.width * .8;
      return y < rect.top || (y <= rect.bottom && (multiColumn ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2));
    });
    return { status: statusOf(project), beforeId: next?.dataset.projectOrderCard || null };
  }
  useEffect(() => {
    if (!drag) return;
    let frame;
    const tick = () => {
      const p = pointer.current;
      if (p?.active) {
        const bounds = p.scrollContainer?.getBoundingClientRect();
        const top = Math.max(0, bounds?.top || 0), bottom = Math.min(window.innerHeight, bounds?.bottom || window.innerHeight);
        const delta = p.y < top + 70 ? p.y - top - 70 : p.y > bottom - 70 ? p.y - bottom + 70 : 0;
        if (delta) {
          (p.scrollContainer || window).scrollBy(0, Math.sign(delta) * Math.min(16, Math.abs(delta) / 4));
          p.target = targetAt(p.x, p.y, p.project); setDrag({ ...p });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const cancel = () => { pointer.current = null; setDrag(null); };
    const key = (event) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', key); window.addEventListener('blur', cancel);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', key); window.removeEventListener('blur', cancel); };
  }, [drag?.project.project_id]);

  async function save(next) {
    if (busy.current) return;
    const current = projects.map((project) => project.project_id);
    if (next.every((id, index) => id === current[index])) { setNotice('이미 해당 순서입니다.'); return; }
    busy.current = true; setSaving(true); setError(''); setNotice('');
    try { await onSave(next, current); if (mounted.current) setNotice('과제 순서를 저장했습니다.'); }
    catch (err) { if (mounted.current) setError(err.message); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  function reorder(project, beforeId) {
    const group = projects.filter((item) => statusOf(item) === statusOf(project)).map((item) => item.project_id);
    const remaining = group.filter((id) => id !== project.project_id);
    if (beforeId !== null && !remaining.includes(beforeId)) return;
    remaining.splice(beforeId === null ? remaining.length : remaining.indexOf(beforeId), 0, project.project_id);
    let index = 0;
    save(projects.map((item) => statusOf(item) === statusOf(project) ? remaining[index++] : item.project_id));
  }
  function sortAscending() {
    const groups = { in_progress: [], done: [] };
    projects.forEach((project) => groups[statusOf(project)].push(project));
    Object.values(groups).forEach((group) => group.sort((a, b) => collator.compare(a.project_name, b.project_name)));
    const positions = { in_progress: 0, done: 0 };
    save(projects.map((project) => { const status = statusOf(project); return groups[status][positions[status]++].project_id; }));
  }
  function finish(event, cancelled) {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (p.active && !cancelled) {
      const target = targetAt(event.clientX, event.clientY, p.project);
      if (target) reorder(p.project, target.beforeId);
    }
  }
  function handleProps(project) {
    return {
      onPointerDown(event) {
        if (busy.current || !event.isPrimary || event.button !== 0) return;
        pointer.current = { project, scrollContainer: event.currentTarget.closest('[data-project-order-scroll]'), id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event) {
        const p = pointer.current;
        if (!p || p.id !== event.pointerId) return;
        p.x = event.clientX; p.y = event.clientY;
        if (!p.active && Math.hypot(p.x - p.startX, p.y - p.startY) < 6) return;
        p.active = true; p.target = targetAt(p.x, p.y, project); setDrag({ ...p });
      },
      onPointerUp: (event) => finish(event, false),
      onPointerCancel: (event) => finish(event, true),
      onLostPointerCapture: (event) => finish(event, true),
      onDragStart: (event) => event.preventDefault(),
      onKeyDown(event) {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key) || busy.current || pointer.current) return;
        event.preventDefault();
        const group = projects.filter((item) => statusOf(item) === statusOf(project));
        const index = group.findIndex((item) => item.project_id === project.project_id);
        if (event.key === 'ArrowUp' && index > 0) reorder(project, group[index - 1].project_id);
        if (event.key === 'ArrowDown' && index < group.length - 1) reorder(project, group[index + 2]?.project_id || null);
      },
    };
  }
  return { saving, locked: saving || !!drag, error, notice, drag, sortAscending, handleProps };
}
