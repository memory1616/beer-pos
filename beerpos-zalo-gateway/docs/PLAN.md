# PLAN - Danh sach file (Giai doan 3)

> Ke hoach trien khai. CHUA trien khai gi - cho xac nhan truoc.

## A. File TAO MOI trong `beerpos-zalo-gateway/`

```
beerpos-zalo-gateway/
|-- package.json
|-- .env.example
|-- .gitignore
|-- README.md
|-- CHANGELOG.md
|-- jest.config.js
|
|-- src/
|   |-- app.js
|   |-- server.js
|   |-- config/index.js
|   |-- logger.js
|   |-- database/
|   |   |-- connection.js
|   |   |-- migrator.js
|   |   |-- migrations/001_init.js
|   |   `-- repositories/
|   |       |-- GroupRepository.js
|   |       |-- JobRepository.js
|   |       |-- MessageRepository.js
|   |       |-- SettingsRepository.js
|   |       |-- AccountRepository.js
|   |       `-- AuditRepository.js
|   |-- providers/
|   |   |-- MessageProvider.js
|   |   |-- MockProvider.js
|   |   `-- index.js
|   |-- services/
|   |   |-- GroupService.js
|   |   |-- MessageService.js
|   |   |-- QueueService.js
|   |   |-- WorkerService.js
|   |   |-- AuditService.js
|   |   |-- SettingsService.js
|   |   `-- CsvService.js
|   |-- controllers/
|   |   |-- healthController.js
|   |   |-- accountController.js
|   |   |-- groupController.js
|   |   |-- messageController.js
|   |   |-- settingsController.js
|   |   `-- auditController.js
|   |-- routes/
|   |   |-- index.js
|   |   |-- health.js
|   |   |-- account.js
|   |   |-- groups.js
|   |   |-- messages.js
|   |   |-- settings.js
|   |   `-- audit.js
|   |-- middleware/
|   |   |-- auth.js
|   |   |-- rateLimit.js
|   |   |-- errorHandler.js
|   |   `-- requestContext.js
|   |-- validators/
|   |   |-- groupValidators.js
|   |   |-- messageValidators.js
|   |   `-- commonValidators.js
|   `-- utils/
|       |-- csv.js
|       |-- errors.js
|       |-- crypto.js
|       `-- logger.js
|
|-- public/
|   |-- index.html
|   |-- css/style.css
|   `-- js/{app,dashboard,groups,queue,history,account,settings}.js
|
|-- scripts/
|   |-- migrate.js
|   |-- seed.js
|   |-- backup.js
|   `-- reset.js
|
|-- tests/
|   |-- groups/groups.test.js
|   |-- groups/import.test.js
|   |-- messages/send.test.js
|   |-- messages/history.test.js
|   |-- queue/queue.test.js
|   |-- queue/worker.test.js
|   |-- providers/mock.test.js
|   |-- security/auth.test.js
|   `-- integration/e2e.test.js
|
`-- data/.gitkeep
```

## B. File TAO MOI trong BeerPOS (Giai doan 5)

| File | Noi dung |
|---|---|
| `src/services/notify/GatewayClient.js` | HTTP client toi Gateway. Timeout, retry, mapping loi sang `ProviderResult`. |
| `src/services/notify/provider/GatewayAdapter.js` | Provider adapter -> `ProviderResult`. |

## C. File SUA (nho, additive) trong BeerPOS (Giai doan 5)

| File | Thay doi | Rui ro |
|---|---|---|
| `src/services/notify/provider/index.js` | them `case 'gateway'` (~10 dong) | Rat thap |
| `routes/api/debtLedger.js` | (tuy chon) endpoint tra cuu job Gateway | Rat thap |

## D. File GIU NGUYEN TUYET DOI

| File | Ly do |
|---|---|
| `src/services/OmiCallService.js` | Provider dang chay |
| `src/services/debt/DebtNotifyService.js` | Dieu phoi + dung noi dung |
| `src/services/debt/DebtPaymentService.js` | Nghiep vu thanh toan |
| `src/services/debt/DebtSepayService.js` | Nghiep vu SePay |
| `src/services/debt/DebtZaloBridge.js` | Adapter pattern |
| `src/services/debt/DebtLedgerService.js` | So cong no + outbox hook |
| `src/services/debt/DebtManualService.js` | Ghi no / dieu chinh / dao |
| `src/services/debt/DebtCommandService.js` | Parser lenh |
| `src/services/notify/*` (7 file) | Da test 47 case - tai dung |
| `database/migrations/*` | Khong sua migration cu |
| `database.sqlite` | Du lieu van hanh |
| `views/debts.html` | UI so cong no dang chay |
| `server.js`, `middleware/*`, `routes/api/*` khac | Khong lien quan |

## E. Truong hop thay doi (khong the tranh)

| Truong hop | Ly do |
|---|---|
| `.gitignore` cua repo `D:\Beer` | Can them `beerpos-zalo-gateway/node_modules/`, `beerpos-zalo-gateway/data/*.sqlite*` neu Gateway nam trong repo. Neu de Gateway ngoai repo rieng -> khong can. |
| `package.json` cua repo `D:\Beer` | Neu quyet dinh dung chung node_modules -> them script `gateway:*`. Khong them dependency vao BeerPOS. |

## F. Quyet dinh can chot truoc khi trien khai

| # | Quyet dinh | De xuat |
|---|---|---|
| Q1 | Gateway nam trong `D:\Beer\beerpos-zalo-gateway/` hay thu muc rieng? | Trong repo, de chung git. Nhom `beerpos-zalo-gateway/` trong monorepo, tach biet hoan toan ve runtime. |
| Q2 | Nguon chan ly mapping | `gateway_groups` la chan ly. BeerPOS giu `debt_customer_groups` de tuong thich + fallback khi Gateway offline. |
| Q3 | Co commit he thong thong bao noi bo (12 modified + 5 untracked) truoc khi tich hop khong? | **Co** - tao moc khoi phuc. Khong commit tu dong, chi khi ban xac nhan. |
| Q4 | BeerPOS co tu dong dong bo mapping 2 chieu khong? | Khong. Chi doc tu Gateway. Ghi mapping van o UI cua BeerPOS (de khong phai nhap 2 lan). |
| Q5 | Co dung `groupId` tu BeerPOS khong? | Khong. Gateway tu tra - chong gui nham nhom (quy tac 1:1). |
