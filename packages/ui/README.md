# 共享 UI 组件

学生、负责人和审核后台共用 `@hongyan/ui`。两端入口引入 `theme.css` 和 `pages.css`。组件遵循[三端界面规范](../../DESIGN.md#桌面布局与共享记录组件)，字段、数据来源和可执行操作由业务页面传入。

| 组件 | 输入与交互 | 使用位置 |
| --- | --- | --- |
| [RecordSummaryList](src/RecordSummaryList.vue) | `records` 提供 id、标题、状态、摘要和日期，可补充活动名、日期显示文本及未读标记。`title` 插槽可链接到对象详情，`action` 插槽接收该行原始对象，用于确认回执或打开关联活动。外层使用 `reading-area`。 | [通知](../../apps/web/src/notices/MyNotices.vue)、[我的报名](../../apps/web/src/registrations/MyRegistrations.vue) |
| [RecordTable](src/RecordTable.vue) | `label` 是表格可访问名称，`heading` 是标识列名。记录的 title 作为行标题，fields 的字段名对应列，值在手机上随字段名纵排。可用 `statusHeading` 增设状态列。 | [现场人员记录](../../apps/web/src/activities/OrganizerSection.vue)、[个人时长](../../apps/web/src/personal/StudentRecords.vue) |
| [RecordWorkspace](src/RecordWorkspace.vue) | `list` 放队列，`detail` 放所选对象。调用方用路由决定 `selected`，负责鉴权、请求及提交。在宽屏选中记录时左右并排，在窄屏保留当前面板和返回入口。 | [真实活动审核](../../apps/admin/src/activities/ReviewPage.vue)、[示例管理页面](../../apps/admin/src/management/ManagementPage.vue) |
| [PreviewRecords](src/PreviewRecords.vue) | 接受示例记录、标题、基础路径及选中的 ID。传入 `tableHeading` 使用字段表，其余使用搜索队列和详情插槽。预览操作由调用方标识，不能把操作描述当作真实写入结果。 | [负责人业务区](../../apps/web/src/activities/OrganizerSection.vue)、[审核管理页](../../apps/admin/src/management/ManagementPage.vue) |

从包导出的组件路径使用 `@hongyan/ui/RecordTable.vue` 等同名入口。共享记录类型见 [preview.ts](src/preview.ts)。[三个可复验的页面示例](../../docs/ui-samples/README.md)
