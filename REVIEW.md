# Rà soát mã nguồn trước triển khai — 19/09/2026

Đã sửa trực tiếp mã nguồn; chưa triển khai Internet hoặc khởi động lại máy chủ đang phục vụ. Các bài kiểm thử chạy trên SQLite trong bộ nhớ, không mở database vận hành.

## Những lỗi đã xử lý

- Tạo nhân viên: sửa câu SELECT thiếu từ khóa khiến tài khoản đã tạo nhưng API báo lỗi.
- Thao tác ghi và lịch sử thay đổi nằm trong cùng giao dịch; thất bại thì hoàn tác.
- Không ghi mật khẩu/mã băm/token vào audit mới; lọc trường nhạy cảm khi trả audit cũ. Những bản ghi audit cũ trên ổ đĩa chưa bị chỉnh sửa.
- Đổi mật khẩu hoặc thay đổi quyền, trạng thái, trại phụ trách sẽ thu hồi phiên cũ. Bảo vệ quản trị viên hoạt động cuối cùng.
- Tài khoản đăng ký mới mặc định chờ duyệt; thêm nút duyệt/khóa người xem. Tài khoản hiện có giữ nguyên trạng thái.
- Bổ sung giới hạn đăng ký, đăng nhập và đổi mật khẩu. Bộ đếm nằm trong bộ nhớ của một tiến trình, được đặt lại khi khởi động lại.
- Đồng bộ độ dài mật khẩu tối thiểu 8 ký tự; giới hạn 72 byte UTF-8 để tránh bcrypt âm thầm cắt mật khẩu dài. Tạo quản trị viên lần đầu yêu cầu ít nhất 12 ký tự.
- Cho phép để trống số điện thoại tùy chọn khi đăng ký.
- Bịt đường truy cập trại lưu trữ trong danh sách tổng và xuất Excel; cấm thêm/sửa/xóa heo, ghi chăm sóc trong trại lưu trữ.
- Khi xóa heo, snapshot giữ cả nhật ký chăm sóc; giao dịch bảo đảm lịch sử và thao tác xóa nhất quán.
- Kiểm tra ngày thực tế, số nguyên không âm và kiểu dữ liệu cho cả thêm/sửa heo.
- Mã hóa tên trại còn sót khi dựng HTML; xử lý dữ liệu phiên bị hỏng và phiên hết hạn.
- Dừng bộ cập nhật nền khi đổi tab/đăng xuất; hiển thị lỗi thao tác bất đồng bộ.
- Đọc thời gian SQLite theo UTC và hiển thị/xuất giờ Việt Nam; không cảnh báo quá hạn ngay trong ngày dự kiến đẻ.
- Đổi nhãn chỉ số tính từ số nái đã đẻ/đã phối để không gọi nhầm là tỷ lệ thụ thai; biểu đồ quý chỉ lấy năm hiện tại.
- Trả lỗi JSON thống nhất, không trả stack trace cho client; bỏ CORS mở toàn bộ vì giao diện/API cùng nguồn.
- Cho phép DATABASE_PATH riêng, thêm thời gian chờ SQLite và đóng kết nối khi tắt máy chủ.
- Cập nhật uuid phụ thuộc của ExcelJS lên bản vá 11.1.1 bằng override; đã kiểm tra xuất/đọc Excel và conditional formatting.
- Thêm .gitignore để tránh đưa cấu hình bí mật, database, node_modules và tệp mật khẩu quản trị lên kho mã.

## Kết quả xác minh

- `npm test`: 16/16 kiểm tra đạt; bao gồm API thực qua HTTP nội bộ, phân quyền, thu hồi phiên, hoàn tác khi audit lỗi, dữ liệu đầu vào, Excel và hàm giao diện.
- `node --check`: mã JavaScript không có lỗi cú pháp.
- `npm audit --omit=dev`: không còn cảnh báo tại thời điểm kiểm tra.
- Kiểm thử giao diện hiện ở mức hàm; chưa kiểm tra thao tác trực quan trên điện thoại và trình duyệt thật.

## Trước khi chạy thật

1. Sao lưu database nhất quán, gồm dữ liệu còn trong WAL, trước khi khởi động bản mới. Không chép riêng file SQLite đang được ghi.
2. Dùng Node.js 24 trở lên; cấu hình JWT_SECRET ngẫu nhiên mạnh, NODE_ENV=production, DATABASE_PATH trên ổ lưu trữ bền vững có thư mục cha tồn tại.
3. TRUST_PROXY_HOPS chỉ đặt đúng số lớp proxy tin cậy; không cho truy cập thẳng máy chủ ứng dụng khi dựa vào cấu hình này để xác định IP.
4. Khởi động lại ứng dụng để nạp mã mới. Khi khởi động, migration bổ sung token_version cho tài khoản hiện có; không thay mật khẩu hoặc trạng thái của họ.
5. Kiểm thử thực tế đăng nhập, tạo nhân viên, duyệt người xem, ghi chăm sóc và xuất Excel trên thiết bị sử dụng tại trại.
6. Cấu hình HTTPS, tự khởi động, sao lưu định kỳ/khôi phục thử và theo dõi lỗi. Chưa thiết lập những phần hạ tầng này trong lượt rà soát mã nguồn.

## Giới hạn cần biết

- Cơ chế giới hạn yêu cầu hiện phục vụ một tiến trình. Nếu chạy nhiều bản ứng dụng, cần bộ đếm dùng chung.
- Phiên vẫn lưu trong localStorage; đã bổ sung escape và CSP nhưng cần tiếp tục giữ kỷ luật xử lý dữ liệu khi thêm giao diện mới.
- Chưa kiểm thử tải hoặc xử lý xung đột khi hai người cùng sửa một bản ghi. Hiện lần lưu sau ghi đè giá trị trường được gửi.
- Chưa có mô hình lịch sử riêng cho từng chu kỳ sinh sản. Cần thống nhất nghiệp vụ trước khi tính các chỉ số thụ thai và phối lại chuyên sâu.
