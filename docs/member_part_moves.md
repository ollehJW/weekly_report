# 파트별 멤버 배정

파트 관리의 위쪽에는 미분류 멤버, 아래에는 파트별 멤버 박스를 표시합니다. 카드에는 이름과 직책만 표시합니다. 드래그하거나 카드를 누른 뒤 대상 파트를 골라 이동할 수 있습니다. 미분류로 되돌릴 수도 있습니다.

이 화면은 사이드바 선택에 관계없이 팀 전체 멤버를 보여줍니다. 소속 part_id와 표시 순서만 변경하며 기존 과제 배정, 일정 참여 및 보고 기록은 보존합니다. 다른 파트로 옮긴 멤버도 기존 보고에서 계속 확인할 수 있습니다. 새 보고는 현재 파트의 멤버로 개설됩니다.

GET /api/teams/{team_id}/parts/members
PUT /api/teams/{team_id}/parts/members/{user_id}

이동 요청은 part_id와 expected_part_id를 전달합니다. 미분류는 null입니다. 다른 팀의 멤버/파트, 삭제된 대상, 파트 사용 중단 및 동시 변경을 검증합니다. 응답에는 비밀번호 정보가 포함되지 않습니다.

검증: .venv/bin/python -m unittest discover -s tests -p 'test_part*.py'
