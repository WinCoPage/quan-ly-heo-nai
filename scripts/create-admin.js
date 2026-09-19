require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { validPassword } = require('../utils/validation');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => {
    resolve(answer.trim());
  }));
}

function secretQuestion(prompt) {
  return question(`${prompt} (ký tự sẽ hiển thị khi nhập): `);
}

async function main() {
  await db.ready;
  const existingAdmin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) {
    throw new Error('Đã tồn tại quản trị viên. Dùng chức năng đổi mật khẩu sau khi đăng nhập.');
  }

  const username = await question('Tên đăng nhập quản trị viên: ');
  const fullName = await question('Họ và tên quản trị viên: ');
  const password = await secretQuestion('Mật khẩu quản trị viên (ít nhất 12 ký tự): ');
  const confirmation = await secretQuestion('Nhập lại mật khẩu: ');

  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error('Tên đăng nhập chỉ được gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.');
  }
  if (!fullName || fullName.length > 120) throw new Error('Họ và tên cần từ 1 đến 120 ký tự.');
  if (!validPassword(password, 12)) throw new Error('Mật khẩu quản trị viên cần ít nhất 12 ký tự, tối đa 72 byte UTF-8.');
  if (password !== confirmation) throw new Error('Hai lần nhập mật khẩu không giống nhau.');
  if (await db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    throw new Error('Tên đăng nhập đã tồn tại.');
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  await db.prepare(
    "INSERT INTO users (username, password_hash, full_name, role, status) VALUES (?, ?, ?, 'admin', 'approved')"
  ).run(username, passwordHash, fullName);
  console.log(`Đã tạo quản trị viên '${username}'. Mật khẩu không được lưu trong mã nguồn hoặc log.`);
}

main().catch((error) => {
  console.error(`Không thể tạo quản trị viên: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  rl.close();
  await db.close();
});
