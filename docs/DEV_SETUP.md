# Dev Tools Setup

P2 bổ sung các công cụ chuẩn hoá code. **Sau khi merge P2, bạn cần chạy lệnh sau một lần**:

```bash
npm install
```

Lệnh này sẽ cài:
- `eslint` (linter)
- `prettier` (formatter)
- `husky` (Git hooks)
- `lint-staged` (chạy linter/formatter trên file đã stage)

## Scripts

```bash
npm run lint            # Kiểm tra lỗi
npm run lint:fix        # Auto-fix
npm run format          # Format toàn bộ
npm run format:check    # Check format (dùng trong CI)
npm run bump:version    # Đồng bộ version package.json + public/version.json
```

## Husky pre-commit

Sau `npm install`, hook pre-commit sẽ tự động chạy `lint-staged` (eslint + prettier) trên file đã stage. Nếu muốn tắt tạm thời:

```bash
git commit --no-verify
```

## Config files

- `.eslintrc.cjs` — ESLint config
- `.prettierrc.json` — Prettier config
- `.prettierignore` — File Prettier bỏ qua
- `package.json` — `lint-staged` section

## Ignore

Cả ESLint và Prettier đều bỏ qua:
- `node_modules/`, `coverage/`, `public/`, `scripts/debug/`, `docs/`
- File build output (`*.min.js`)
