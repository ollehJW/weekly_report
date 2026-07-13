import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Plus, Trash2, AudioWaveform, User, ChevronRight, CornerDownRight, FolderPlus } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000';
const DAY = 24 * 60 * 60 * 1000;
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const ACCENTS = [
  { id: 'indigo', bar: '#4F46E5' },
  { id: 'teal', bar: '#0F8B8D' },
  { id: 'coral', bar: '#D8592F' },
  { id: 'amber', bar: '#B8790F' },
];
const STATUS_STYLE = {
  planned: { label: '예정', bg: '#F1F0EC', text: '#6B6A63' },
  in_progress: { label: '진행중', bg: '#EEEDFE', text: '#4F46E5' },
  done: { label: '완료', bg: '#E4F5EC', text: '#0E8F52' },
  blocked: { label: '차단', bg: '#FCF1EC', text: '#B0331C' },
};
const WAVE_PATTERN = [4, 9, 6, 13, 8, 15, 7, 11, 5, 10, 6, 14, 9, 4, 12, 7];

function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayIso() {
  return isoOf(new Date());
}

function businessDaysBetween(startIso, endIso) {
  const start = toDate(startIso);
  const end = toDate(endIso);
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function normalizeStatus(status) {
  if (status === '예정') return 'planned';
  if (status === '진행중') return 'in_progress';
  if (status === '완료') return 'done';
  return status || 'planned';
}

function accentFor(index) {
  return ACCENTS[index % ACCENTS.length];
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function WaveBar({ widthPx, color }) {
  const bars = Math.max(6, Math.round(widthPx / 9));
  return (
    <svg width="100%" height="14" viewBox={`0 0 ${bars * 6} 16`} preserveAspectRatio="none" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const amp = WAVE_PATTERN[i % WAVE_PATTERN.length];
        return <rect key={i} x={i * 6 + 1} y={(16 - amp) / 2} width="3" height={amp} rx="1.5" fill={color} opacity="0.9" />;
      })}
    </svg>
  );
}

function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [addingProject, setAddingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState({ title: '', description: '' });
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [milestoneDraft, setMilestoneDraft] = useState({ title: '', description: '', start_date: todayIso(), end_date: isoOf(new Date(Date.now() + DAY * 14)) });

  const selectedProject = projects.find((project) => project.id === selectedProjectId) || null;

  async function loadProjects(nextProjectId) {
    const list = await request('/api/projects');
    setProjects(list);
    const id = nextProjectId !== undefined ? nextProjectId : selectedProjectId || list[0]?.id || null;
    setSelectedProjectId(id);
    return id;
  }

  async function loadMilestones(projectId) {
    if (!projectId) {
      setMilestones([]);
      return;
    }
    const list = await request(`/api/projects/${projectId}/milestones`);
    const details = await Promise.all(list.map((item) => request(`/api/milestones/${item.id}`)));
    setMilestones(details);
  }

  async function refresh(projectId) {
    setError('');
    const id = await loadProjects(projectId);
    await loadMilestones(id);
  }

  useEffect(() => {
    refresh()
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    loadMilestones(selectedProjectId).catch((err) => setError(err.message));
  }, [selectedProjectId]);

  async function createProject() {
    if (!projectDraft.title.trim()) {
      setAddingProject(false);
      return;
    }
    try {
      const created = await request('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title: projectDraft.title.trim(), description: projectDraft.description.trim() }),
      });
      setProjectDraft({ title: '', description: '' });
      setAddingProject(false);
      await refresh(created.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteProject(id) {
    try {
      await request(`/api/projects/${id}`, { method: 'DELETE' });
      const fallback = projects.find((project) => project.id !== id)?.id || null;
      await refresh(fallback);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createMilestone() {
    if (!selectedProjectId || !milestoneDraft.title.trim()) {
      setAddingMilestone(false);
      return;
    }
    try {
      await request(`/api/projects/${selectedProjectId}/milestones`, {
        method: 'POST',
        body: JSON.stringify({
          title: milestoneDraft.title.trim(),
          description: milestoneDraft.description.trim(),
          start_date: milestoneDraft.start_date,
          end_date: milestoneDraft.end_date,
        }),
      });
      setMilestoneDraft({ title: '', description: '', start_date: todayIso(), end_date: isoOf(new Date(Date.now() + DAY * 14)) });
      setAddingMilestone(false);
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteMilestone(id) {
    try {
      await request(`/api/milestones/${id}`, { method: 'DELETE' });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createEpic(milestone, draft) {
    if (!draft.name.trim()) return;
    try {
      const accent = accentFor(milestone.epics.length);
      await request(`/api/milestones/${milestone.id}/epics`, {
        method: 'POST',
        body: JSON.stringify({
          title: draft.name.trim(),
          owner: draft.owner.trim(),
          status: 'planned',
          color: accent.bar,
          start_date: draft.start_date,
          end_date: draft.end_date,
        }),
      });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function deleteEpic(id) {
    try {
      await request(`/api/epics/${id}`, { method: 'DELETE' });
      await refresh(selectedProjectId);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <AudioWaveform size={22} />
          <div>
            <h1>마일스톤</h1>
            <span>AI project timeline</span>
          </div>
        </div>

        <div className="side-block">
          <div className="side-head">
            <span>Projects</span>
            <button className="icon-btn" onClick={() => setAddingProject(true)} title="프로젝트 추가"><FolderPlus size={15} /></button>
          </div>
          <select className="project-select" value={selectedProjectId || ''} onChange={(e) => setSelectedProjectId(Number(e.target.value) || null)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          {addingProject && (
            <div className="side-add-form">
              <input autoFocus placeholder="프로젝트 이름" value={projectDraft.title} onChange={(e) => setProjectDraft({ ...projectDraft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && createProject()} />
              <input placeholder="설명" value={projectDraft.description} onChange={(e) => setProjectDraft({ ...projectDraft, description: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && createProject()} />
              <div className="inline-actions"><button className="mt-btn primary sm" onClick={createProject}>추가</button><button className="mt-btn sm" onClick={() => setAddingProject(false)}>취소</button></div>
            </div>
          )}
          {selectedProject && (
            <div className="project-summary">
              <strong>{selectedProject.title}</strong>
              <small>{selectedProject.milestone_count} milestones · {selectedProject.epic_count} epics</small>
              <button className="mt-btn danger sm" onClick={() => deleteProject(selectedProject.id)}><Trash2 size={13} />삭제</button>
            </div>
          )}
        </div>
      </aside>

      <section className="workspace">
        {error && <div className="error">{error}</div>}
        <div className="page-head">
          <div>
            <h1>마일스톤</h1>
            <p>{selectedProject ? `${milestones.length}개의 마일스톤 · ${selectedProject.title}` : '프로젝트를 선택하세요'}</p>
          </div>
        </div>

        {loading && <div className="empty">불러오는 중</div>}
        {!loading && selectedProject && (
          <>
            <div className="milestone-stack">
              {milestones.map((milestone) => (
                <MilestoneCard
                  key={milestone.id}
                  project={selectedProject}
                  milestone={milestone}
                  onRemove={() => deleteMilestone(milestone.id)}
                  onAddEpic={(draft) => createEpic(milestone, draft)}
                  onRemoveEpic={deleteEpic}
                />
              ))}
            </div>

            <div className={`add-milestone${addingMilestone ? ' editing' : ''}`}>
              {addingMilestone ? (
                <div className="add-milestone-form">
                  <input name="mtitle" placeholder="마일스톤 이름" value={milestoneDraft.title} autoFocus onChange={(e) => setMilestoneDraft({ ...milestoneDraft, title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && createMilestone()} />
                  <input placeholder="설명" value={milestoneDraft.description} onChange={(e) => setMilestoneDraft({ ...milestoneDraft, description: e.target.value })} />
                  <input type="date" value={milestoneDraft.start_date} onChange={(e) => setMilestoneDraft({ ...milestoneDraft, start_date: e.target.value })} />
                  <span>→</span>
                  <input type="date" value={milestoneDraft.end_date} onChange={(e) => setMilestoneDraft({ ...milestoneDraft, end_date: e.target.value })} />
                  <button className="mt-btn primary sm" onClick={createMilestone}>추가</button>
                  <button className="mt-btn sm" onClick={() => setAddingMilestone(false)}>취소</button>
                </div>
              ) : (
                <button className="add-milestone-btn" onClick={() => setAddingMilestone(true)}><Plus size={15} />마일스톤 추가</button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function MilestoneCard({ project, milestone, onRemove, onAddEpic, onRemoveEpic }) {
  const [addingEpic, setAddingEpic] = useState(false);
  const [draft, setDraft] = useState({ name: '', owner: '', start_date: milestone.start_date, end_date: milestone.end_date });
  const days = useMemo(() => businessDaysBetween(milestone.start_date, milestone.end_date), [milestone.start_date, milestone.end_date]);
  const colCount = Math.max(1, days.length);
  const dayIndex = useMemo(() => {
    const map = new Map();
    days.forEach((day, i) => map.set(isoOf(day), i));
    return map;
  }, [days]);
  const gridTemplate = `220px repeat(${colCount}, minmax(64px, 1fr))`;

  function span(epic) {
    const epicDays = businessDaysBetween(epic.start_date, epic.end_date);
    const first = epicDays[0] ? isoOf(epicDays[0]) : epic.start_date;
    const last = epicDays[epicDays.length - 1] ? isoOf(epicDays[epicDays.length - 1]) : epic.end_date;
    const startCol = dayIndex.has(first) ? dayIndex.get(first) : 0;
    const endCol = dayIndex.has(last) ? dayIndex.get(last) : colCount - 1;
    return { startCol, colSpan: Math.max(1, endCol - startCol + 1) };
  }

  function commitAddEpic() {
    if (!draft.name.trim()) {
      setAddingEpic(false);
      return;
    }
    onAddEpic(draft);
    setDraft({ name: '', owner: '', start_date: milestone.start_date, end_date: milestone.end_date });
    setAddingEpic(false);
  }

  return (
    <article className="mt-card">
      <div className="mt-card-titlebar">
        <div>
          <p className="mt-crumb"><AudioWaveform size={12} />{project.title}<ChevronRight size={11} />마일스톤</p>
          <h2 className="mt-title">{milestone.title}</h2>
          <p className="mt-desc">{milestone.description || '설명이 없습니다.'}</p>
        </div>
        <div className="mt-actions">
          <button className="mt-btn danger" onClick={onRemove}><Trash2 size={14} />삭제</button>
        </div>
      </div>

      <div className="mt-card-head">
        <p className="mt-card-eyebrow"><AudioWaveform size={14} color="#4F46E5" />Epic Timeline</p>
        <p className="mt-card-sub mono">{milestone.start_date} → {milestone.end_date} · <b>{days.length}영업일</b> · Epic {milestone.epics.length}개</p>
      </div>

      <div className="mt-grid-wrap">
        <div className="mt-grid" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="mt-headercell">Epic</div>
          {days.map((day) => <div key={isoOf(day)} className={`mt-daycell${day.getDay() === 1 ? ' weekend-adjacent' : ''}`}><div className="num">{String(day.getDate()).padStart(2, '0')}</div><div className="dow">{DOW[day.getDay()]}</div></div>)}

          <div className="mt-milestone-band" style={{ gridColumn: `1 / span ${colCount + 1}` }}>
            <div className="mt-milestone-band-inner"><AudioWaveform size={14} className="icon" /><span className="name">{milestone.title}</span><span className="count">{milestone.epics.length} epics</span></div>
          </div>

          {milestone.epics.map((epic, index) => {
            const { startCol, colSpan } = span(epic);
            const status = STATUS_STYLE[normalizeStatus(epic.status)] || STATUS_STYLE.planned;
            const isLast = index === milestone.epics.length - 1 && !addingEpic;
            return (
              <React.Fragment key={epic.id}>
                <div className={`mt-row-label epic${isLast ? ' last' : ''}`}>
                  <div><div className="name">{epic.title}</div><div className="meta"><span className="mt-avatar"><User size={9} /></span>{epic.owner || '담당 미지정'} · <span className="mt-badge" style={{ background: status.bg, color: status.text }}>{status.label}</span></div></div>
                  <button className="mt-delete" onClick={() => onRemoveEpic(epic.id)} aria-label="Epic 삭제"><Trash2 size={13} /></button>
                </div>
                <div className="mt-track" style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
                  {days.map((day, i) => <div key={isoOf(day)} className={`mt-daybg${day.getDay() === 1 ? ' weekend-adjacent' : ''}`} style={{ gridRow: 1, gridColumn: i + 1 }} />)}
                  <div className="mt-bar" style={{ gridColumn: `${startCol + 1} / span ${colSpan}`, background: epic.color || accentFor(index).bar }}>
                    <div className="wave"><WaveBar widthPx={colSpan * 70} color="#FFFFFF" /></div>
                    <span className="label">{epic.title}</span>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

          <div className={`mt-row-label epic last add-slot${addingEpic ? ' editing' : ''}`}>
            {addingEpic ? (
              <div className="mt-add-form"><input name="name" placeholder="Epic 이름" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && commitAddEpic()} /></div>
            ) : (
              <button className="mt-add-leaf" onClick={() => setAddingEpic(true)}><CornerDownRight size={13} />Epic 추가</button>
            )}
          </div>
          {addingEpic && (
            <div className="mt-track add-track" style={{ gridColumn: `2 / span ${colCount}`, gridTemplateColumns: `repeat(${colCount}, 1fr)` }}>
              {days.map((day, i) => <div key={isoOf(day)} className="mt-daybg" style={{ gridRow: 1, gridColumn: i + 1 }} />)}
              <div className="mt-date-inputs" style={{ gridColumn: `1 / span ${colCount}` }}>
                <input placeholder="담당" value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} />
                <input type="date" min={milestone.start_date} max={milestone.end_date} value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} />
                <span>→</span>
                <input type="date" min={milestone.start_date} max={milestone.end_date} value={draft.end_date} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} />
                <button className="mt-btn primary sm" onMouseDown={(e) => e.preventDefault()} onClick={commitAddEpic}>추가</button>
                <button className="mt-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setAddingEpic(false)}>취소</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

createRoot(document.getElementById('root')).render(<App />);
