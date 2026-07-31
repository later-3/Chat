# Identity、HTTPS、Authentication Session 与 Scope 迁移详细设计

> 状态：**已批准的详细设计；尚未实现**（2026-07-30）  
> 工作包：`W2-01`  
> 授权来源：用户要求连续完成详细设计与架构调整，不再逐项暂停确认。  
> 当前事实：产品仍使用固定`local-user` Scope，公网验证仍是HTTP + Basic Auth；本文不能被表述成正式Identity、HTTPS或多用户已经可用。

## 1. 结论

Chat采用服务端权威Identity和不透明Cookie会话：

1. `Principal`表示人或服务身份，`Scope`表示数据边界，二者不再用同一个`local-user`字符串混合表达。
2. `RoleDefinition + RoleGrant`表示“谁在什么Scope上具有什么能力”；超级管理员必须是显式Grant，不由前端开关或邮箱猜测。
3. `AuthenticationSession`拥有登录、轮换、空闲过期、绝对过期、撤销和设备会话生命周期；它不是Product Session。
4. 浏览器只持有高熵不透明Session token的安全Cookie，数据库只存token摘要；不把认证token放进`localStorage/sessionStorage`。
5. 所有公网流量先切HTTPS；同源Web/API使用`Secure + HttpOnly + SameSite` Cookie、Origin校验和CSRF token保护写请求。
6. 现有数据原地迁移为一个真实Owner Principal和一个保留稳定ID的个人Scope；先双读审计、再切授权、最后移除Basic Auth和固定Principal注入。

安全基线核对自[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)与[MDN Cookie安全指南](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies)。这些是安全标准依据，不是新增产品架构参考项目。

## 2. 目标保证与非目标

### 2.1 目标保证

1. 每个请求有可信`AccessContext(principal, authentication_session, scope, grants)`。
2. 查询先做Scope与对象授权；不可见与不存在可统一404防止资源枚举。
3. 认证、授权、产品会话、浏览器活跃、Run耗时分别记录，不能互相冒充。
4. 用户能查看并撤销自己的登录设备；管理员访问敏感跨用户视图必须产生审计。
5. 账号停用、Grant撤销和Auth Session撤销能在有界时间内生效。
6. Web、AG-UI、Obsidian导出、Channel Adapter和管理员REST使用同一授权内核。

### 2.2 非目标

1. 首个切片不自行实现OAuth/OIDC Provider、社交登录、企业SSO或MFA；保留Authenticator Adapter。
2. 不使用JWT承载全部授权事实；角色变化和撤销应立即由服务端权威状态决定。
3. 不把IP地址或User-Agent当身份，也不因IP变化自动销毁合法移动会话。
4. 不在本设计中实现Super Admin Console、Usage Aggregate或Delivery Channel Binding业务页面。

## 3. 权威对象

### 3.1 Principal

| 字段 | 约束 |
|---|---|
| `id` | 稳定UUID，不复用用户名/邮箱 |
| `kind` | `human/service` |
| `display_name` | 用户可见名称 |
| `status` | `pending/active/suspended/disabled` |
| `created_at/updated_at` | UTC |
| `row_version` | CAS |

邮箱、用户名或外部Subject通过`PrincipalIdentifier`维护，规范化值在其命名空间内唯一；删除标识不删除Principal历史。

### 3.2 Scope与成员关系

首个正式切片只有`personal` Scope，但Schema允许后续`organization/team`：

| 对象 | 关键字段 |
|---|---|
| `Scope` | `id, kind, display_name, owner_principal_id, status, row_version` |
| `ScopeMembership` | `scope_id, principal_id, status, joined_at, row_version` |

所有领域资源继续保存`scope_id`；Owner不是“拥有数据库中所有行”的绕过角色，仍走授权策略。

### 3.3 RoleDefinition与RoleGrant

首批内置角色：

| 角色 | 目标能力 |
|---|---|
| `personal_owner` | 管理自己Scope中的产品资源、会话和个人导出 |
| `collaborator` | 只在被授予的Scope/资源能力内协作 |
| `service_agent` | 仅执行RunSpec授予的有界机器能力 |
| `super_administrator` | 运营看护与授权管理；敏感读取必须审计 |

`RoleGrant`字段至少包括`principal_id, role_key, scope_kind, scope_ref_id, capability_set, status, valid_from, expires_at, granted_by, decision_record_id, row_version`。系统安全下限始终能收紧Grant；前端显示角色不能赋权。

### 3.4 Credential

Credential是Identity私有对象，绝不进入Projection、Trace或浏览器响应：

1. 首个本地Authenticator使用`LocalPasswordCredential`，保存自描述的Argon2id摘要，不保存明文或可逆密文。
2. 参数由锁定库生成并达到当时OWASP基线；登录成功时可渐进升级work factor。
3. 恢复码、外部OIDC Subject或Passkey以后以独立Credential类型接入，不塞进Principal JSON。
4. 初始化Owner凭据必须由显式CLI/一次性引导完成；不得在启动日志生成默认弱密码。

### 3.5 AuthenticationSession

| 字段 | 说明 |
|---|---|
| `id` | 服务端会话稳定ID |
| `principal_id` | 登录Principal |
| `token_digest` | 不透明Cookie token的带域SHA-256/HMAC摘要；唯一 |
| `csrf_secret_digest` | CSRF会话绑定摘要 |
| `status` | `active/revoked/expired/ended` |
| `authenticated_at` | 凭据验证时间 |
| `last_seen_at` | 认证请求活动；有写节流 |
| `idle_expires_at` | 空闲过期 |
| `absolute_expires_at` | 绝对过期，滚动访问不能延长 |
| `rotated_from_id` | 登录/提权后轮换血缘 |
| `revoked_at/reason_code` | 撤销证据 |
| `device_label` | 用户可识别、可修订的设备名 |
| `user_agent_summary/ip_prefix` | 风险与审计提示；不是身份和永久画像 |
| `row_version` | CAS |

默认时长由私有运行配置显式注入并有安全上限；产品UI必须分别显示“登录会话到期”“最近认证活动”和“当前浏览器前台活跃”，不得用其中一个替代另一个。

### 3.6 ChannelBinding

外部Channel身份映射由Identity拥有：`platform, external_subject_id_hash, principal_id, scope_id, status, verification_state, capabilities, row_version`。平台用户ID不能直接成为Principal ID；未验证Binding不能读取既有私人Scope。

## 4. 浏览器与HTTPS边界

### 4.1 部署拓扑

```text
Browser
  -- HTTPS only --> Trusted reverse proxy
  -- loopback/private HTTP --> FastAPI
```

1. 公网HTTP只做301/308到HTTPS，不承载登录或Session Cookie。
2. Proxy终止TLS、设置HSTS和安全响应头；FastAPI只信任显式代理地址的Forwarded Header。
3. 后端和Worker保持回环/私网监听；反向隧道不能把裸后端端口公开。
4. Web与API保持同源；生产CORS不使用通配Origin或携凭据的任意Origin。

### 4.2 Cookie

使用类似：

```text
Set-Cookie: __Host-chat-session=<opaque>; Secure; HttpOnly; SameSite=Lax; Path=/
```

采用`__Host-`要求无`Domain`且`Path=/`；如果未来必须跨子域共享，必须重新做威胁审核。登录、轮换和注销响应使用`Cache-Control: no-store`。Cookie内不放Principal、Role、Scope或长期授权声明。

### 4.3 CSRF与请求来源

1. `GET/HEAD/OPTIONS`严格无状态变更。
2. `POST/PUT/PATCH/DELETE`要求合法Origin/Referer且携`X-CSRF-Token`；token与当前Auth Session绑定。
3. CSRF token通过受认证同源端点取得，只保存在前端内存；不写认证Storage。
4. AG-UI POST/Resume、Obsidian导出之外的候选写回和管理员命令同样受保护。
5. Channel Webhook使用平台签名/重放窗，不使用浏览器CSRF机制。

## 5. 请求认证与授权流程

```text
HTTPS request
 -> 解析安全Cookie
 -> token digest查询AuthenticationSession
 -> 检查状态、idle/absolute expiry与Principal状态
 -> 有界更新last_seen_at
 -> 构造AccessContext
 -> Router声明required capability
 -> AuthorizationService检查Scope、Grant、系统下限与资源可见性
 -> Application Coordinator
 -> Owner Query/Command再次接收AccessContext/Scope，不信任客户端scope_id
```

规则：

1. 客户端可以请求目标资源ID，但不能声明自己是谁或可看哪个Scope。
2. Router做粗粒度能力门，应用层/领域查询做资源级门；两层不是重复，防止内部调用绕过。
3. Projection Envelope返回当前视图的`permissions`，但它只是服务端授权结果的可读投影，不是授权来源。
4. 401表示没有有效Authentication Session；403表示身份有效但能力不足；404用于隐藏其他Scope对象。

## 6. Auth Session生命周期

```text
credential verified
 -> active session + rotated token
 -> idle activity with write throttling
 -> rotate on login / privilege elevation / credential change
 -> revoked | idle_expired | absolute_expired | ended
```

1. 登录前后都重新生成token，防止Session fixation。
2. 密码修改、账号停用、关键Grant提升和用户“退出所有设备”撤销相关会话。
3. 单设备注销在一个事务内标记`ended`并清Cookie；清Cookie失败也不能让服务端会话继续有效。
4. 并发轮换只允许一个新token生效；旧token进入短暂、单次、只允许换取新Cookie的过渡窗或立即失效，具体实现选择必须有重放测试。
5. `last_seen_at`按固定时间桶节流，避免每个静态请求写库；只由认证业务请求更新，Worker心跳和Token使用量不更新。

## 7. 角色与信息显示

| 读者 | 可见 | 不可见/受限 |
|---|---|---|
| 未认证访客 | 登录页、服务健康的最小公开信息 | Project、Session、模型/Provider私有配置 |
| 普通用户/Owner | 自己Scope的Workspace、Project Dossier、责任、来源revision、自己的Auth Sessions | 他人Scope、管理员聚合、完整敏感Trace |
| Collaborator | Grant覆盖的资源和允许动作 | Scope其他资源、Owner凭据与私人记忆 |
| Service Agent | RunSpec中最小工作包、工具授权、公开结果合同 | 任意目录遍历、Credential、未纳入Context |
| Super Admin | 运营聚合、异常、授权管理；敏感内容按额外理由门 | Credential secret、隐藏推理；不能直接改领域表 |

跨用户管理员访问必须记录`SuperAdminAuditEvent(principal, target_scope, capability, reason, request_id, timestamp, result)`；超级管理员不能绕过Evidence、Approval或Tool提交门。

## 8. 固定`local-user`迁移

迁移分6步，失败可停在上一阶段：

1. **盘点**：统计每张含`scope_id/principal_id/created_by`表的行数和非法值；生成只含计数/Hash的迁移报告。
2. **建Identity表**：创建一个真实Owner Principal、一个`personal` Scope。为避免重写所有外键，首个Scope保留现有ID `local-user`；Principal使用新的稳定UUID。
3. **建立Grant**：创建Owner Membership与`personal_owner` Grant；旧`created_by=local-user`通过可审计映射回填为Owner Principal，不改来源时间。
4. **双读影子授权**：现有固定入口继续服务，新的Authorizer同时计算结果并只记录差异；任何差异阻止切换。
5. **正式切换**：HTTPS上线、显式初始化凭据、Auth Session Cookie接入；所有HTTP/AG-UI查询从AccessContext注入Scope，客户端传入Principal/Scope被忽略或拒绝。
6. **清退过渡层**：撤下公网Basic Auth与固定Principal依赖；保留迁移映射和审计，不删除历史ID。回滚只回应用版本，不回滚已创建的Identity事实。

迁移前后必须满足：每个资源仍属于同一Scope、所有UUID和row_version不变、Project/Session数量不变、跨Scope查询为0、全部现有用户场景仍可打开。

## 9. 命令、查询与错误

### 9.1 REST

```text
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/logout-all
GET    /api/auth/me
GET    /api/auth/csrf
GET    /api/auth/sessions
DELETE /api/auth/sessions/{session_id}
GET    /api/identity/scopes
GET    /api/identity/grants               (按权限)
POST   /api/identity/grants               (管理员/Owner门)
DELETE /api/identity/grants/{grant_id}
```

认证端点统一限流，但不把“用户不存在”和“密码错误”区分给匿名调用方。创建/撤销Grant带`command_id`与CAS，并写Identity Audit/Outbox。

### 9.2 稳定错误

`AUTHENTICATION_REQUIRED`、`AUTHENTICATION_FAILED`、`AUTH_SESSION_EXPIRED`、`AUTH_SESSION_REVOKED`、`CSRF_VALIDATION_FAILED`、`SCOPE_FORBIDDEN`、`GRANT_REQUIRED`、`GRANT_REVISION_CONFLICT`、`PRINCIPAL_DISABLED`、`IDENTITY_MIGRATION_INCOMPLETE`。

日志不能记录密码、Cookie、CSRF token、完整外部Subject或Credential摘要。

## 10. 事务与模块边界

1. Identity Service是Principal/Scope/Grant/Auth Session命令的唯一事务所有者。
2. 领域模块只接收不可变`AccessContext`和Scope ID；不查询Credential表。
3. Super Admin Operations消费Identity公开Event/Query，自有活动与审计表；不复制Auth Session状态。
4. Channel Adapter通过Identity Binding Query解析Principal，再调用统一Interaction Ingress。
5. Projection依赖Identity Authorization Query过滤字段；源模块不依赖Projection。
6. 登出/撤销会话写Identity事实和Outbox同事务；通知其他设备失败不恢复会话。

## 11. 测试与验收

### 11.1 安全合同

1. 无Cookie、伪造、过期、撤销、轮换前token全部401。
2. 已认证越权为403或防枚举404，绝不回其他Scope元数据。
3. Cookie固定含`Secure/HttpOnly/SameSite/Path`，无`Domain`；敏感响应`no-store`。
4. 所有写方法缺失/错误Origin或CSRF token失败；GET无副作用。
5. 登录/提权轮换、并发轮换、注销、全设备撤销和密码修改撤销通过。
6. 登录限流、统一错误文本、Argon2参数升级与Unicode密码通过。

### 11.2 数据与迁移

1. 迁移前后对象计数、稳定ID、revision和来源Hash一致。
2. 双读Authorizer对当前合法场景0差异。
3. 中途崩溃可幂等重跑；不存在半个Grant或无Principal资源。
4. 旧固定Scope只在Migration Adapter出现，源码机器检查阻止新增硬编码。

### 11.3 用户场景

1. 桌面/手机HTTPS登录、刷新、PWA启动和流式AG-UI回合。
2. 在“登录设备”中识别并撤销另一设备，目标设备下一次请求进入认证恢复。
3. 用户只能看到自己的工作台和Obsidian导出；篡改Project ID不可越权。
4. Super Admin读取运营聚合产生审计，普通用户访问管理端被拒绝。

## 12. 落地顺序与完成口径

1. 新增Identity Schema、服务、AccessContext和安全测试。
2. 部署HTTPS与同源Cookie/CSRF边界。
3. 执行固定Scope迁移和影子授权。
4. 切换REST、AG-UI、Projection和Channel入口。
5. 加入设备会话与Grant UI，移除Basic Auth过渡。

本文关闭AD3和W2-01的**详细设计缺口**。正式Schema、迁移、HTTPS证书、登录UI和真实多Principal尚未实施，因此工作包保持`in_progress`，Project State必须继续显示当前固定Scope限制。
