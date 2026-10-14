import React from 'react';
import { UserRound, LogOut } from 'lucide-react';
import './axAccount.css';

// Shared account presentation across AX for Works and its four agents.
export default function AXAccount({ name, team, admin = false, onLogout, onProfile, disabled = false, header = false }) {
  const Identity = onProfile ? 'button' : 'div';
  const detail = admin ? '관리자' : (team && team !== '미지정' ? team : '소속 팀 미지정');
  return <div className={`ax-account${header ? ' ax-account--header' : ''}`}>
    <Identity className="ax-account__identity" {...(onProfile ? { type: 'button', onClick: onProfile, 'aria-label': '내 계정 정보 수정' } : {})}>
      <span className="ax-account__avatar" aria-hidden="true"><UserRound size={20}/></span>
      <span className="ax-account__text"><strong title={name}>{name || '사용자'}</strong><small title={detail}>{detail}</small></span>
      <span className="ax-account__online" aria-hidden="true"/>
    </Identity>
    <button className="ax-account__logout" type="button" onClick={onLogout} disabled={disabled}><LogOut size={16} aria-hidden="true"/>로그아웃</button>
  </div>;
}
