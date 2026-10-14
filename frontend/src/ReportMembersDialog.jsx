import { useEffect, useRef, useState } from 'react';
import './reportMembers.css';

export default function ReportMembersDialog({ teamId, request, onClose, onSaved }) {
  const dialog = useRef(null);
  const [rows, setRows] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    let active = true;
    request(`/api/teams/${teamId}/report-members`).then(data => {
      if (active) { setRows(data); setSelected(data.filter(m => m.report_enabled).map(m => m.user_id)); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; previous?.focus(); };
  }, [teamId]);
  async function save() {
    setBusy(true); setError('');
    try {
      await request(`/api/teams/${teamId}/report-members`, { method: 'PUT', body: JSON.stringify({
        enabled_ids: selected, expected_enabled_ids: rows.filter(m => m.report_enabled).map(m => m.user_id),
        expected_member_ids: rows.map(m => m.user_id),
      }) });
      await onSaved(); onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const visible = (rows || []).filter(m => `${m.name} ${m.position} ${m.part_name}`.includes(query.trim()));
  return <dialog ref={dialog} className="report-members-dialog" aria-labelledby="report-members-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header><div><span className="report-eyebrow">REPORT MEMBERS</span><h2 id="report-members-title">주간 보고 멤버 관리</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="닫기">×</button></header>
    <p>우리 팀에서 주간 보고를 작성할 멤버를 선택하세요.</p>
    <div className="report-members-note">팀 전체에 공통으로 저장되며, 진행 중인 보고와 앞으로 개설되는 보고에 적용됩니다. 기존 작성 내용과 완료된 보고는 보존됩니다. 새로 합류한 팀원은 기본으로 포함됩니다.</div>
    <div className="report-members-tools"><input aria-label="멤버 검색" placeholder="이름, 직급, 파트 검색" value={query} onChange={e => setQuery(e.target.value)} /><strong>{selected.length} / {rows?.length || 0}명 선택</strong></div>
    <div className="report-members-select"><button disabled={!rows || busy} onClick={() => setSelected(rows.map(m => m.user_id))}>전체 선택</button><button disabled={!rows || busy} onClick={() => setSelected([])}>전체 해제</button></div>
    <div className="report-members-list" aria-busy={!rows}>
      {!rows && !error && <p>멤버를 불러오는 중입니다.</p>}
      {rows && !visible.length && <p>검색 결과가 없습니다.</p>}
      {visible.map(m => <label key={m.user_id} className={selected.includes(m.user_id) ? 'selected' : ''}><input type="checkbox" disabled={busy} checked={selected.includes(m.user_id)} onChange={e => setSelected(current => e.target.checked ? [...current, m.user_id] : current.filter(id => id !== m.user_id))} /><span><b>{m.name}</b><small>{m.position}{m.part_name !== '미지정' ? ` · ${m.part_name}` : ''}</small></span><em>{selected.includes(m.user_id) ? '작성 대상' : '대상 제외'}</em></label>)}
    </div>
    {rows && !selected.length && <p className="report-members-warning">선택한 멤버가 없으면 주간 보고를 작성하거나 완료할 수 없습니다.</p>}
    {error && <p role="alert" className="report-members-warning">{error}</p>}
    <footer><button onClick={onClose} disabled={busy}>취소</button><button className="primary" onClick={save} disabled={!rows || busy}>{busy ? '저장 중…' : '설정 저장'}</button></footer>
  </dialog>;
}
