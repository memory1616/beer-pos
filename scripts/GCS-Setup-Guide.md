# Hướng dẫn tạo Google Cloud Storage Bucket cho backup

## Bước 1: Mở Google Cloud Console
https://console.cloud.google.com/

Đảm bảo bạn đang ở đúng project `red-data-488701-v9` (project đã tạo từ trước).

## Bước 2: Tạo Bucket
1. Menu ☰ → **Cloud Storage** → **Buckets**
2. Click **+ Create Bucket**

### Cấu hình:
- **Name**: `beerpos-backup-2026` (phải unique toàn cầu, có thể thêm ngày)
- **Location type**: `Region` → `asia-southeast1` (Singapore - gần VN)
- **Storage class**: `Standard`
- **Access control**: `Uniform` (mặc định)
- Click **Create**

## Bước 3: Cấp quyền cho Service Account
1. Vào bucket vừa tạo → tab **Permissions**
2. Click **+ Grant Access**
3. **New principals**: paste email SA:
   ```
   credentials-466@red-data-488701-v9.iam.gserviceaccount.com
   ```
4. **Role**: `Storage Object Admin` (full quyền upload/delete)
5. Click **Save**

## Bước 4: Gửi cho tôi
- ✅ Tên bucket bạn đã tạo (ví dụ: `beerpos-backup-2026`)

Sau khi có tên bucket, tôi sẽ:
1. Config rclone cho GCS
2. Test upload
3. Tạo backup script
4. Setup cron tự động
