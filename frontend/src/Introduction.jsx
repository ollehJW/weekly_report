import React from 'react';
import { ChartNoAxesCombined, ArrowRight, ArrowUpRight, Users, FolderKanban, ClipboardList, FileText } from 'lucide-react';
import './introduction.css';

const HOME = 'https://axforwork.wia.co.kr';
const SERVICE = HOME + '/wiareport';
const steps = [
  [Users, '01', '우리 팀의 업무를 준비하세요', '팀 멤버와 과제를 등록하고 담당자를 연결하세요. 마일스톤과 세부 작업으로 일정과 진행 상태를 관리합니다.', '팀·과제 준비'],
  [ClipboardList, '02', '한 주의 업무를 기록하세요', '보고 주간을 열고 참여 과제별로 진행 업무, 리스크·이슈, 다음 계획을 작성하세요. 팀원별 작성 상태도 함께 확인합니다.', '주간보고 작성'],
  [FileText, '03', '팀의 흐름을 한눈에 확인하세요', '작성된 보고를 멤버별·과제별로 확인하세요. 완료된 주간보고는 라운지에서 다시 살펴보고 지난 기록과 다음 계획을 연결합니다.', '보고 확인·회고'],
];
export default function Introduction() {
  return <div className="intro-page">
    <header className="intro-header">
      <a className="intro-brand" href={SERVICE + '/'}><ChartNoAxesCombined size={26}/><span>WiaReport</span></a>
      <a className="meet-platform-return" href={HOME + '/'}>AX for Works로 돌아가기 <ArrowUpRight size={16}/></a>
    </header>
    <main className="intro-main">
      <section className="intro-hero">
        <div className="intro-hero-copy">
          <div className="intro-eyebrow"><span/>HYUNDAI WIA · TEAM WORK INTELLIGENCE</div>
          <h1>한 주의 기록을 모아,<br/>우리 팀의 다음을 잇는,<br/><em>WiaReport.</em></h1>
          <p>흩어진 업무 기록은 한곳에, 팀의 진행 상황은 한눈에.<br/>과제와 일정, 주간보고를 연결해<br/>이번 주의 성과와 다음 계획을 함께 확인합니다.</p>
          <div className="intro-hero-actions">
            <a className="intro-primary" href={SERVICE + '/agent'}>우리 팀 주간보고 시작하기<ArrowRight size={18}/></a>
            <a className="intro-text-link" href="#intro-how">어떻게 이용하나요?<ArrowRight size={15} style={{transform:'rotate(90deg)'}}/></a>
          </div>
        </div>
        <div className="intro-video-column">
          <div className="intro-video-topline"><span>SERVICE FILM</span></div>
          <video className="intro-video" controls preload="metadata" playsInline aria-label="WiaReport 서비스 소개 영상">
            <source src={SERVICE + '/media/WiaReport_intro.mp4'} type="video/mp4"/>이 브라우저는 영상 재생을 지원하지 않습니다.
          </video>
          <p className="intro-video-foot">보고를 모으는 시간은 줄이고, 팀의 실행에 집중하세요.</p>
        </div>
      </section>
      <section className="intro-benefits" aria-label="주요 기능">
        {[[FolderKanban,'과제와 일정을 한곳에','담당자 · 마일스톤 · 세부 작업 관리'],[ClipboardList,'업무의 흐름을 주간보고로','진행 업무 · 리스크·이슈 · 다음 계획'],[FileText,'팀의 기록을 함께 확인','멤버별·과제별 보고 · 주간 보고 라운지']].map(([Icon,title,text])=>
          <div key={title}><span><Icon size={21}/></span><div><h2>{title}</h2><p>{text}</p></div></div>)}
      </section>
      <section className="intro-how" id="intro-how">
        <div className="intro-section-head"><div><span className="intro-eyebrow">HOW IT WORKS</span><h2>팀의 업무 준비부터, 한 주의 회고까지.</h2></div><p>담당 과제와 일정을 연결하고,<br/>매주 쌓이는 기록으로 팀의 흐름을 확인하세요.</p></div>
        <div className="intro-steps">{steps.map(([Icon,n,title,text,tag])=><article key={n}>
          <div className="intro-step-top"><Icon size={23}/><span>{n}</span></div><span className="intro-step-tag">{tag}</span><h3>{title}</h3><p>{text}</p>
        </article>)}</div>
      </section>
      <section className="intro-guide">
        <div className="intro-guide-icon"><ClipboardList size={35}/><span>PDF GUIDE</span></div>
        <div className="intro-guide-copy"><span className="intro-eyebrow">QUICK START GUIDE</span><h2>처음이라면, 가이드와 함께.</h2><p>팀 설정부터 과제 등록, 주간보고 작성과 완료까지.<br/>PDF 가이드에서 단계별 이용 방법을 확인하세요.</p></div>
        <a className="intro-guide-download" href={SERVICE + '/media/WIAReport_Guide.pdf'} download="WIAReport_Guide.pdf">PDF 가이드 다운로드<FileText size={16}/></a>
      </section>
    </main>
    <footer className="intro-footer"><span><b>HYUNDAI WIA</b><i/>WiaReport</span><p>Connect your work. Move forward together.</p></footer>
  </div>;
}
