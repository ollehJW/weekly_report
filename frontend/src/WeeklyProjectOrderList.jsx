import React from 'react';
import { GripVertical } from 'lucide-react';
import { useProjectOrder } from './useProjectOrder.js';

export default function WeeklyProjectOrderList({ projects, selectedId, onSelect, onReorder }) {
  // Completion status is a label here, not a separate ordering group.
  const order = useProjectOrder(projects.map((project) => ({ ...project, status: 'in_progress' })), onReorder);
  return <div className="weekly-order-list" data-project-order-status="in_progress">
    <p className="weekly-order-guide">손잡이를 드래그해 작성 순서를 바꿀 수 있습니다.</p>
    {order.error && <p className="parts-error" role="alert">{order.error}</p>}
    <div className="weekly-project-items" data-project-order-list>
      {projects.map((project) => <div key={project.project_id} data-project-order-card={project.project_id} className={`weekly-order-row${order.drag?.project.project_id === project.project_id ? ' is-order-dragging' : ''}${order.drag?.target?.beforeId === project.project_id ? ' is-order-before' : ''}`}>
        <button type="button" className="project-order-handle" aria-label={`${project.project_name} 작성 순서 변경`} title="드래그 또는 위·아래 방향키로 순서 변경" disabled={order.saving} {...order.handleProps({ ...project, status: 'in_progress' })}><GripVertical size={16} /></button>
        <button className={`weekly-project-item${selectedId === project.project_id ? ' active' : ''}`} type="button" disabled={order.locked} onClick={() => onSelect(project)}>
          <span>{project.project_name}</span>{project.status === 'done' && <b className="entry-state done">작성 완료</b>}
        </button>
      </div>)}
      {order.drag?.target && order.drag.target.beforeId === null && <div className="project-order-tail" aria-hidden="true">맨 뒤에 놓기</div>}
      {!projects.length && <div className="empty compact">선택된 과제가 없습니다</div>}
    </div>
    <p className="weekly-order-status" role="status">{order.saving ? '순서 저장 중…' : order.notice}</p>
    {order.drag && <div className="project-order-ghost" aria-hidden="true" style={{ left: Math.min(order.drag.x + 14, window.innerWidth - 225), top: Math.min(order.drag.y + 14, window.innerHeight - 65) }}>{order.drag.project.project_name}</div>}
  </div>;
}
