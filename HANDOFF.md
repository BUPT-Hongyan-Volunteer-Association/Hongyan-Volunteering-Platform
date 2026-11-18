# 三端页面与业务交接

先按 [README](README.md) 启动 Web、审核后台和 API。学生和负责人共用 Web，后台身份使用独立入口。工程在 packages/contracts 提供 [OpenAPI](packages/contracts/openapi_v1.2.4.yaml) 和两份空白模板。下表接口名采用契约中的 operationId，生成客户端使用对应的驼峰名称。

| 责任组与验收 | 页面、代码与当前来源 | 接口、依赖与首个演示 |
| --- | --- | --- |
| 账号与权限 FR06，AC01、AC02 | 后台 /manage/students、/manage/imports、/manage/accounts、/manage/audit。学生、五列建档与后台操作见 [管理页面](apps/admin/src/management/ManagementPage.vue) 和 [样例](apps/admin/src/management/sections.ts)。[登录与改密](packages/ui/src/AccountGate.vue)读取真实会话。 | 账号与权限组连接 `upload_student_import`、`get_student_import_rows`、`commit_student_import`。首先让老师上传名单并定位原表行。学生档案启停接 `update_student`，独立后台账号启停接 `set_account_status`。依赖文件校验、角色及对象授权。 |
| 活动与日程 FR01、FR07，AC02、AC03、AC10 | 真实列表和获批详情在 [PublicActivities](apps/web/src/activities/PublicActivities.vue)，草稿送审在 [ActivityEditor](apps/web/src/activities/ActivityEditor.vue)，冻结版本审批在 [ReviewPage](apps/admin/src/activities/ReviewPage.vue)。/schedule、/mine/schedule、/managed-schedule 与后台 /schedule 复用 [SchedulePage](packages/ui/src/timeline/SchedulePage.vue) 和 [SVG 时间轴](packages/ui/src/timeline/TimelineChart.vue)。 | 用 `get_timeline` 替换 [示例响应](packages/ui/src/timeline/examples.ts)，保留授权范围、窗口、版本和分钟比例。首先用列表和周图定位同一个获批时段。补齐日、月粒度、分页、计划重叠、60 秒校时、终态及三类时间配置。成员变更使用活动团队版本及有效角色。 |
| 报名与退出 FR02，AC04 | 学生 /activities/:id 的报名按钮和 /registrations 的 [本人记录](apps/web/src/personal/StudentRecords.vue)。负责人 /managed/:id/roster 的 [名单](apps/web/src/registrations/Roster.vue) 使用合成数据，可筛选、分页及跨页选择。退出／恢复在 /managed/:id/requests。 | 接 `apply_for_activity`、`list_activity_registrations`、`list_my_registrations`。首先让学生申请，在负责人名单和本人页面查到同一条待审核报名。退出与恢复历史分别接 `list_my_exit_requests`、`list_my_restoration_requests`。依赖活动锁、报名窗口、当前成员和名额。 |
| 通知与现场 FR03，AC05 | 学生 /notices，[负责人通知回执和按日期的现场记录](apps/web/src/notices/organizer.ts)位于 /managed/:id/notices、/managed/:id/attendance。后台 /manage/failures 为失败队列。页面均为示例，真实活动审批已生成相应变更事件。 | 接 `list_my_notices`、`read_notice`、`acknowledge_notice`、`list_notice_receipts`、`list_attendance`。首先让学生确认具体通知后，负责人查看更新的待跟进名单。依赖业务事件、投递去重及通知版本，失败队列接 `list_notification_events` 和 `retry_notification_event`。 |
| 时长与更正 FR04，AC06–AC09 | 学生 /mine/hours 和 /mine/feedback，负责人 [批次、漏记反馈、修复组](apps/web/src/hours/organizer.ts) 对应 /managed/:id/batches、/managed/:id/appeals、/managed/:id/corrections。后台 [时长审核](apps/admin/src/hours/HourReview.vue) 位于 /hours，修复组位于 /manage/corrections。七列预览及审核、累计、撤旧建新均为示例。 | 接 `upload_hour_batch`、`get_hour_batch_rows`、`submit_hour_batch`、`review_hour_batch`、`list_my_hours`。首先让负责人预览行校验，老师批准后学生读到有效明细及累计。依赖原表行、历史获批安排和审核事务。漏记接 `list_activity_hour_appeals`，与异常组联合验证逐行核实。 |
| 异常与申诉 FR05，AC09 | 负责人 /managed/:id/incidents 的 [异常报告](apps/web/src/incidents/organizer.ts)，后台 /manage/incidents、/manage/appeals，学生 /mine/feedback 的本人记录和说明表单。事实、核实、本人可见证据及进度使用合成样例。 | 接 `report_incident`、`review_incident`、`list_my_incidents`、`create_appeal`。首先让老师核实后学生看到本人记录并提交说明。依赖活动授权、合并审核、原件与脱敏副本权限。自动限制保持关闭。 |

负责人各业务区共用 [工作区](apps/web/src/activities/ActivityWorkspace.vue) 的成员核验和 [分区详情](apps/web/src/activities/OrganizerSection.vue)。两端示例共用 [列表与详情](packages/ui/src/PreviewRecords.vue)，实际请求均由 [共享客户端](packages/contracts/src/index.ts) 发出。真实请求失败时，页面显示错误及重试入口。示例操作只显示预览结果。

## 在新副本中接手报名

1. 学生登录后从「活动」打开「校园服务甲」。[详情按钮](apps/web/src/activities/PublicActivities.vue)已取得获批活动 ID，接 `apply_for_activity` 后需展示服务端返回的报名状态。
2. 另开负责人会话，从「我的 → 活动管理 → 校园服务甲 → 报名名单」打开名单。以 `list_activity_registrations` 替换 Roster.vue 的 samples 与本地筛选，沿用 Pager、选中 ID 集合和整项名额。先按权限与筛选汇总，再取页。
3. 学生从「我的报名」打开同一条记录。以 `list_my_registrations` 替换 [personalRecords](apps/web/src/personal/examples.ts) 的报名数据。同一次申请、负责人名单和本人结果须能以同一个报名 ID 对照。
4. 服务端已有活动与学生唯一关系。复用 [真实会话](apps/api/src/auth/session.guard.ts)、[授权范围](apps/api/src/activities/read.ts) 及 [活动事务](apps/api/src/activities/workflow.ts)。报名与批量录取需要新增业务实现及名额并发回归。正式请求成功后才显示已提交或已录取。

## 日程样例的范围

两项种子活动经真实公开、本人或管理列表核验后才进入对应日程。其时段和计算时刻使用固定样例，另一个独立的公开单次活动用于列表与周图对照。没有本人录取活动时显示空结果。使用协作者体验账号可查看带本人录取关系的样例。示例时刻为北京时间 2026-11-18 10:00。11 月 18 日可检查当前线，11 月 21 日可检查多个分钟级时段。真实活动内容从单独的详情入口进入，审核页始终读取服务端冻结版本。

批次 02 完成页面交接。后续各业务组负责正式接口及事务验收，公共集成负责 AC11 性能和 AC12 产品总验收。个人分工由项目负责人另行落实。
