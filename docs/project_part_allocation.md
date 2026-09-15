# 파트별 과제 배정 및 순서

파트 관리에서 멤버 배정 / 과제 배정을 전환합니다. 과제 카드는 과제명과 과제리더만 표시하며, 리더가 없으면 리더 미지정으로 표시합니다. 드래그로 미분류와 각 파트를 오가거나 같은 파트에서 순서를 변경합니다. 삽입 위치가 표시되며 저장 성공 후 반영됩니다. 카드 클릭과 파트 선택으로 이동할 수도 있고 Alt+위/아래 방향키로 순서를 변경할 수 있습니다.

과제 이동은 project.part_id를 변경하고 마일스톤/워크는 이 범위를 상속합니다. 리더/참여자 및 기존 주간보고 이력은 보존합니다. 멤버 소속은 별도로 배정합니다. 기존 참여자는 과제 수정 시 유지할 수 있고 새로 추가하는 참여자는 선택한 파트에서 고릅니다. 자동 생성된 기타 업무는 일반 과제 배정에서 제외합니다.

순서는 users.sort_order, project.sort_order에 저장합니다. 기존 과제에는 기존 목록 순서를 유지하도록 순서 값을 채웁니다. 새 과제는 뒤에 추가합니다. 과제 목록과 타임라인도 저장된 순서를 따릅니다.

GET /api/teams/{team_id}/parts/projects
PUT /api/teams/{team_id}/parts/projects/{project_id}
PUT /api/teams/{team_id}/parts/members/{user_id}

이동 요청: part_id, expected_part_id, before_id. 미분류는 null, before_id=null은 맨 뒤입니다. 같은 파트로 요청하면 순서를 변경합니다. 저장은 트랜잭션 안에서 처리하고 다른 팀/삭제된 대상/변경된 소속/파트 사용 중단을 검증합니다.

검증: .venv/bin/python -m unittest discover -s tests -p 'test_part*.py'
