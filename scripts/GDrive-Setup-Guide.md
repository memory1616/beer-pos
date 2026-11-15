# Hướng dẫn tạo Google Service Account cho backup

## Bước 1: Tạo Google Cloud Project
1. Truy cập: https://console.cloud.google.com/
2. Đăng nhập bằng tài khoản Google của bạn
3. Click dropdown project (góc trên) → **New Project**
4. Tên: `beerpos-backup` → Create

## Bước 2: Enable Google Drive API
1. Vào menu ☰ → **APIs & Services** → **Library**
2. Tìm "Google Drive API" → Click → **Enable**

## Bước 3: Tạo Service Account
1. Menu ☰ → **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **Service Account**
3. Điền:
   - Service account name: `beerpos-backup-sa`
   - Service account ID: tự động (giữ nguyên)
4. Click **Create and Continue** → Skip roles → **Done**

## Bước 4: Tạo Key cho Service Account
1. Click vào service account vừa tạo
2. Tab **Keys** → **Add Key** → **Create new key** → **JSON**
3. File sẽ tự download về máy
4. **Đổi tên file thành** `gdrive-sa-key.json`
5. Upload file này lên server tại `/root/gdrive-sa-key.json`

## Bước 5: Chia sẻ folder Google Drive với Service Account
1. Mở Google Drive: https://drive.google.com/
2. Tạo folder mới: `BeerPos-Backup`
3. Click chuột phải → **Share**
4. Copy email của service account (dạng `beerpos-backup-sa@xxx.iam.gserviceaccount.com`)
   - Xem email này trong: GCP Console → IAM & Admin → Service Accounts
5. Paste email vào Share dialog → **Editor** → Share

## Bước 6: Lấy Google Drive Folder ID
1. Mở folder `BeerPos-Backup` vừa tạo
2. Copy phần ID trong URL:
   ```
   https://drive.google.com/drive/folders/1ABC...XYZ  ← ID ở đây
   ```

Sau khi có:
- File `/root/gdrive-sa-key.json` trên server
- Google Drive Folder ID

Gửi lại cho tôi, tôi sẽ:
1. Test kết nối rclone
2. Tạo backup script
3. Setup cron tự động chạy lúc 3 giờ sáng
