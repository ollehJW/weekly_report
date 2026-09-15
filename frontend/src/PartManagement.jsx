import React, { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Users, ArrowRight, X } from 'lucide-react';

const ROLES = { L: '리더', CM: '책임매니저', M: '매니저' };
const groupKey = (partId) => partId || '';

export default function PartManagement(props) {
  const storageKey = `wiareport_assignment_${props.teamId}`;
  const [kind, setKind] = useState(() => sessionStorage.getItem(storageKey) === 'projects' ? 'projects' : 'members');
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  function changeKind(next) { sessionStorage.setItem(storageKey, next); setKind(next); }
  return <PartAssignmentBoard key={kind} {...props} assignmentKind={kind} onKindChange={changeKind} name={name} setName={setName} editing={editing} setEditing={setEditing} />;
}

function PartAssignmentBoard({ teamId, request, onMembersChanged, config, onToggle, onCreate, onRename, onDelete, assignmentKind, onKindChange, name, setName, editing, setEditing }) {
  const isProject = assignmentKind === 'projects';
  const noun = isProject ? '과제' : '멤버';
  const unit = isProject ? '개' : '명';
  const itemId = (item) => isProject ? item.project_id : item.user_id;
  const itemTitle = (item) => isProject ? item.project_name : item.name;
  const itemSubtitle = (item) => isProject ? (item.leader_name || '리더 미지정') : (ROLES[item.role] || item.role);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState(null);
  const [destination, setDestination] = useState('');
  const [notice, setNotice] = useState('');
  const [drag, setDrag] = useState(null);
  const pointer = useRef(null);
  const ignoreClick = useRef(false);
  const destinationRef = useRef(null);
  const mounted = useRef(true);
  const itemsUrl = `/api/teams/${teamId}/parts/${assignmentKind}`;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pointer.current = null; }; }, []);
  useEffect(() => {
    if (!config.enabled) return;
    let active = true;
    setLoading(true); setLoadError('');
    request(itemsUrl).then((rows) => { if (active) setItems(rows); })
      .catch((err) => { if (active) setLoadError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [teamId, config.enabled, reload, request]);

  function hitTarget(x, y) {
    const zone = document.elementFromPoint(x, y)?.closest('[data-part-drop]');
    if (!zone) return null;
    const cards = [...zone.querySelectorAll('[data-assignment-id]')];
    const grid = zone.querySelector('.part-member-grid').getBoundingClientRect();
    let beforeId = null;
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const multiColumn = rect.width < grid.width * .8;
      const before = y < rect.top || (y <= rect.bottom && (multiColumn ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2));
      if (before) { beforeId = card.dataset.assignmentId; break; }
    }
    return { partId: zone.dataset.partDrop, beforeId };
  }
  // Auto-scroll lets a member reach parts farther down the page, including on touch screens.
  useEffect(() => {
    if (!drag) return;
    let frame;
    const tick = () => {
      const p = pointer.current;
      if (p?.active) {
        const edge = 72;
        const distance = p.y < edge ? p.y - edge : p.y > window.innerHeight - edge ? p.y - window.innerHeight + edge : 0;
        if (distance) {
          window.scrollBy(0, Math.sign(distance) * Math.min(16, Math.abs(distance) / 4));
          p.target = hitTarget(p.x, p.y);
          setDrag({ ...p });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const cancel = (event) => { if (!event || event.key === 'Escape') { pointer.current = null; setDrag(null); } };
    const blur = () => cancel();
    window.addEventListener('keydown', cancel); window.addEventListener('blur', blur);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('keydown', cancel); window.removeEventListener('blur', blur); };
  }, [(drag && itemId(drag.member))]);

  async function run(action) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (err) { if (mounted.current) setError(err.message); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  function move(member, partId, beforeId = null) {
    const current = items.filter((item) => groupKey(item.part_id) === groupKey(partId)).map(itemId);
    if (beforeId === itemId(member)) return;
    const reordered = current.filter((id) => id !== itemId(member));
    reordered.splice(beforeId === null ? reordered.length : reordered.indexOf(beforeId), 0, itemId(member));
    if (groupKey(member.part_id) === groupKey(partId) && current.join(',') === reordered.join(',')) return;
    run(async () => {
      try {
        const rows = await request(`${itemsUrl}/${itemId(member)}`, {
          method: 'PUT', body: JSON.stringify({ part_id: partId || null, expected_part_id: member.part_id || null, before_id: beforeId }),
        });
        if (!mounted.current) return;
        setItems(rows); setSelection(null);
        const label = config.parts.find((part) => part.part_id === partId)?.name || '미분류';
        setNotice(groupKey(member.part_id) === groupKey(partId) ? `${itemTitle(member)}: 순서를 변경했습니다.` : `${itemTitle(member)} → ${label}: 이동했습니다.`);
        onMembersChanged?.();
      } catch (err) {
        // Refresh after a conflicting edit; a failed save never moves the card optimistically.
        try { const rows = await request(itemsUrl); if (mounted.current) setItems(rows); } catch {}
        throw err;
      }
    });
  }
  function startDrag(event, member) {
    if (busyRef.current || loading || !event.isPrimary || event.button !== 0) return;
    ignoreClick.current = false;
    pointer.current = { member, id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, target: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function updateDrag(event) {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    p.x = event.clientX; p.y = event.clientY;
    if (!p.active && Math.hypot(p.x - p.startX, p.y - p.startY) < 6) return;
    p.active = true; ignoreClick.current = true;
    p.target = hitTarget(p.x, p.y);
    setSelection(null); setDrag({ ...p });
  }
  function endDrag(event, cancelled = false) {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null; setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (p.active && !cancelled) {
      const target = hitTarget(event.clientX, event.clientY);
      if (target !== null) move(p.member, target.partId, target.beforeId);
    }
  }
  function selectMember(member, event) {
    if (ignoreClick.current && event.detail > 0) { ignoreClick.current = false; return; }
    ignoreClick.current = false;
    setSelection(member); setDestination(groupKey(member.part_id)); setNotice('');
    requestAnimationFrame(() => destinationRef.current?.focus());
  }
  function memberCard(member) {
    return <button key={itemId(member)} type="button"
      className={`part-member-card${drag?.target?.beforeId === itemId(member) && itemId(drag.member) !== itemId(member) ? ' is-drop-before' : ''}${(drag && itemId(drag.member)) === itemId(member) ? ' is-dragging' : ''}${(selection && itemId(selection)) === itemId(member) ? ' is-selected' : ''}`}
      data-assignment-id={itemId(member)} data-member-id={isProject ? undefined : itemId(member)} data-project-id={isProject ? itemId(member) : undefined} disabled={busy || loading} aria-label={`${itemTitle(member)} ${itemSubtitle(member)}, 파트 이동`} aria-pressed={(selection && itemId(selection)) === itemId(member)}
      onKeyDown={(e) => {
        if (!e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key) || busy) return;
        e.preventDefault();
        const group = items.filter((item) => groupKey(item.part_id) === groupKey(member.part_id));
        const index = group.findIndex((item) => itemId(item) === itemId(member));
        if (e.key === 'ArrowUp' && index > 0) move(member, member.part_id, itemId(group[index - 1]));
        if (e.key === 'ArrowDown' && index < group.length - 1) move(member, member.part_id, group[index + 2] ? itemId(group[index + 2]) : null);
      }}
      onPointerDown={(e) => startDrag(e, member)} onPointerMove={updateDrag} onPointerUp={endDrag}
      onPointerCancel={(e) => endDrag(e, true)} onLostPointerCapture={(e) => { if (pointer.current?.id === e.pointerId) endDrag(e, true); }}
      onClick={(event) => selectMember(member, event)} onDragStart={(e) => e.preventDefault()}>
      <span className="part-member-name">{itemTitle(member)}</span><span className="part-member-role">{itemSubtitle(member)}</span>
    </button>;
  }
  function zone(part) {
    const id = part?.part_id || '';
    const people = items.filter((m) => groupKey(m.part_id) === id);
    const over = drag && drag.target?.partId === id;
    return <section key={id} data-part-drop={id} className={`part-member-zone${part ? '' : ' is-unassigned'}${over ? ' is-over' : ''}`} aria-label={part?.name || `미분류 ${noun}`}>
      <div className="part-zone-heading">
        <div className="part-zone-title"><h3>{part?.name || `미분류 ${noun}`}</h3><span>{people.length}{unit}</span></div>
      </div>
      {!part && <p className="part-zone-description">아직 파트가 정해지지 않은 {noun}입니다. 아래 파트로 끌어 놓으세요.</p>}
      <div className="part-member-grid">{people.map(memberCard)}</div>
      {!people.length && <div className="part-zone-empty">{over ? '여기에 놓아 이동' : part ? `${noun}를 이곳으로 끌어 놓으세요` : `모든 ${noun}가 파트에 배정되었습니다`}</div>}
      {over && people.length > 0 && <div className={`part-drop-hint${drag.target.beforeId === null ? ' is-append' : ''}`} aria-hidden="true">{drag.target.beforeId === null ? '맨 뒤에 놓기' : '표시된 위치에 놓기'}</div>}
    </section>;
  }
  return <section className="part-management">
    <div className="page-head"><h1>파트 관리</h1></div>
    <div className="parts-setting">
      <div className="parts-setting-icon"><Users size={22} /></div>
      <div className="parts-setting-copy"><h2>팀이 여러 파트로 나뉘어 있나요?</h2><p>파트를 사용하면 멤버, 과제, 일정과 주간보고를 파트별로 관리할 수 있습니다.</p></div>
      <button className="parts-switch" type="button" role="switch" aria-label="파트 사용" aria-checked={config.enabled} disabled={busy || !!drag} onClick={() => run(() => onToggle(!config.enabled))}><span /></button>
    </div>
    {error && <p className="parts-error" role="alert">{error}</p>}
    {config.enabled && <section className="parts-catalog" aria-label="파트 구성 관리">
      <div className="parts-catalog-head">
        <div><h2>우리 팀의 파트 <span>{config.parts.length}개</span></h2><p>파트를 먼저 구성한 뒤, 아래에서 멤버와 과제를 배정하세요.</p></div>
        <form className="parts-create" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(async () => { await onCreate(name.trim()); setName(''); }); }}>
          <input aria-label="새 파트 이름" placeholder="새 파트 이름" maxLength={80} value={name} disabled={busy || !!drag} onChange={(e) => setName(e.target.value)} />
          <button className="mt-btn primary" type="submit" disabled={busy || !!drag || !name.trim()}><Plus size={15} />파트 추가</button>
        </form>
      </div>
      <ul className="parts-catalog-list">{config.parts.map((part) => <li key={part.part_id}>
        {editing?.id === part.part_id ? <form className="parts-rename" onSubmit={(e) => { e.preventDefault(); if (editing.name.trim()) run(async () => { await onRename(part.part_id, editing.name.trim()); setEditing(null); }); }}>
          <input aria-label="수정할 파트 이름" autoFocus maxLength={80} value={editing.name} disabled={busy} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <button className="mt-btn" disabled={busy || !editing.name.trim()} type="submit">저장</button>
          <button className="mt-btn" disabled={busy} type="button" onClick={() => setEditing(null)}>취소</button>
        </form> : <>
          <span className="parts-catalog-name">{part.name}</span>
          <div className="parts-row-actions">
            <button type="button" className="icon-btn" disabled={busy || !!drag} aria-label={part.name + ' 이름 수정'} onClick={() => setEditing({ id: part.part_id, name: part.name })}><Pencil size={14} /></button>
            <button type="button" className="icon-btn" disabled={busy || !!drag} aria-label={part.name + ' 삭제'} onClick={() => run(() => onDelete(part.part_id))}><Trash2 size={14} /></button>
          </div>
        </>}
      </li>)}</ul>
      {!config.parts.length && <p className="parts-catalog-empty">등록된 파트가 없습니다. 첫 파트를 추가해 주세요.</p>}
    </section>}
    <p className="part-move-status" role="status" aria-live="polite">{busy ? '변경 사항을 저장하고 있습니다…' : notice}</p>
    {config.enabled ? <div className={`parts-editor parts-board${isProject ? ' is-project-board' : ''}${drag ? ' is-dragging' : ''}`} aria-busy={loading || busy}>
      <div className="part-assignment-switch" role="group" aria-label="배정 항목">
        <button type="button" aria-pressed={!isProject} disabled={busy || !!drag} onClick={() => onKindChange('members')}>멤버 배정</button>
        <button type="button" aria-pressed={isProject} disabled={busy || !!drag} onClick={() => onKindChange('projects')}>과제 배정</button>
      </div>
      <div className="parts-editor-head"><h2>파트별 {noun} 배정</h2><span>전체 {items.length}{unit}</span></div>
      <p className="parts-guide">카드를 드래그해 파트를 옮기거나 같은 파트 안에서 순서를 바꿔 보세요. 카드를 누르면 이동할 파트를 선택할 수도 있습니다.</p>
      {selection && <div className="part-move-toolbar">
        <strong>{itemTitle(selection)}</strong><ArrowRight size={16} aria-hidden="true" />
        <select ref={destinationRef} aria-label="이동할 파트" value={destination} onChange={(e) => setDestination(e.target.value)} disabled={busy}>
          <option value="">미분류</option>{config.parts.map((part) => <option key={part.part_id} value={part.part_id}>{part.name}</option>)}
        </select>
        <button type="button" className="mt-btn primary" disabled={busy || destination === groupKey(selection.part_id)} onClick={() => move(selection, destination)}>이동</button>
        <button type="button" className="icon-btn" aria-label="이동 취소" disabled={busy} onClick={() => setSelection(null)}><X size={16} /></button>
      </div>}
      {loading ? <div className="parts-empty">{noun}를 불러오고 있습니다…</div> : loadError ? <div className="parts-error" role="alert">{loadError}<button type="button" className="mt-btn" onClick={() => setReload((v) => v + 1)}>다시 불러오기</button></div> : <>
        {zone(null)}
        <div className="part-board-section-head"><h2>배정할 파트 <span>{config.parts.length}</span></h2></div>
        <div className="part-board-grid">{config.parts.map(zone)}</div>
        {!config.parts.length && <div className="parts-empty">위에서 파트를 추가한 뒤 {noun}를 배정해 주세요.</div>}
      </>}
      <p className="parts-guide part-board-footnote">{isProject ? '과제와 그 안의 마일스톤·워크가 함께 이동합니다. 과제리더·참여자와 작성된 보고 기록은 그대로 유지됩니다.' : '멤버의 소속 파트만 변경됩니다. 기존 과제·일정과 작성된 보고 기록은 그대로 유지됩니다.'}</p>
    </div> : <p className="parts-disabled-note">현재 팀 전체로 관리하고 있습니다. 파트 사용을 꺼도 기존 파트와 데이터는 보존됩니다.</p>}
    {drag && <div className="part-member-ghost" style={{ left: Math.min(drag.x + 14, window.innerWidth - 180), top: Math.min(drag.y + 14, window.innerHeight - 85) }} aria-hidden="true"><span className="part-member-name">{itemTitle(drag.member)}</span><span className="part-member-role">{itemSubtitle(drag.member)}</span></div>}
  </section>;
}
