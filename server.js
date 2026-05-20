const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs'); 
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к MongoDB Atlas (берется из настроек Render)
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Успешно подключено к вечной базе MongoDB Atlas!'))
    .catch(err => console.error('Ошибка подключения к MongoDB:', err));

// Подключение к Cloudinary (для хранения файлов)
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- СХЕМЫ ДАННЫХ ДЛЯ МОНГО ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: String, city: String, school: String,
    name: String, surname: String, subject: String,
    fullName: String, grade: String
});
const User = mongoose.model('User', UserSchema);

const FolderSchema = new mongoose.Schema({
    folderId: { type: String, required: true, unique: true },
    ownerId: String, name: String, password: String, isPrivate: Boolean,
    files: [{ type: { type: String }, name: String, url: String }]
});
const Folder = mongoose.model('Folder', FolderSchema);

const AccessLogSchema = new mongoose.Schema({
    folderId: String, folderName: String, teacherId: String,
    studentName: String, city: String, school: String, grade: String,
    timestamp: String
});
const AccessLog = mongoose.model('AccessLog', AccessLogSchema);

const ActivityLogSchema = new mongoose.Schema({
    userId: String, actionType: String, text: String, timestamp: String
});
const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);

const cyrillicRegex = /^[А-Яа-яЁё\s\-]+$/;
const schoolRegex = /^[А-Яа-яЁёA-Za-z0-9\s\-\.,№()""«»]+$/;

// 1. РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
    const { username, password, role, city, school, name, surname, subject, fullName, grade } = req.body;
    
    if (!username || !password || !role || !city || !school) {
        return res.status(400).json({ success: false, message: 'Все основные поля должны быть заполнены!' });
    }
    if (role === 'teacher' && (!name || !surname || !subject)) {
        return res.status(400).json({ success: false, message: 'Заполните все поля личных данных учителя!' });
    }
    if (role === 'student' && (!fullName || !grade)) {
        return res.status(400).json({ success: false, message: 'Заполните все поля личных данных ученика!' });
    }

    if (!cyrillicRegex.test(city)) return res.status(400).json({ success: false, message: 'Город пишется на русском!' });
    if (!schoolRegex.test(school)) return res.status(400).json({ success: false, message: 'Поле "Школа" заполнено некорректно!' });

    try {
        const candidate = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
        if (candidate) return res.status(400).json({ success: false, message: 'Этот логин уже занят!' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ username, password: hashedPassword, role, city, school });
        if (role === 'teacher') {
            newUser.name = name; newUser.surname = surname; newUser.subject = subject;
        } else {
            newUser.fullName = fullName; newUser.grade = grade;
        }

        await newUser.save();
        res.json({ success: true, message: 'Регистрация успешна!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Ошибка сервера при регистрации.' });
    }
});

// 2. АВТОРИЗАЦИЯ
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Заполните fields!' });

    try {
        const user = await User.findOne({ username: { $regex: new RegExp(`^${username}$`, 'i') } });
        if (!user) return res.status(401).json({ success: false, message: 'Неверный логин или пароль!' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: 'Неверный логин или пароль!' });

        const { password: _, ...safeData } = user._doc;
        res.json({ success: true, user: safeData });
    } catch(e) { res.status(500).json({ success: false }); }
});

// 3. СПИСОК УЧИТЕЛЕЙ
app.get('/api/teachers', async (req, res) => {
    try {
        const teachers = await User.find({ role: 'teacher' });
        const list = await Promise.all(teachers.map(async (t) => {
            const folders = await Folder.find({ ownerId: t.username, isPrivate: false });
            return {
                username: t.username, name: t.name, surname: t.surname,
                subject: t.subject, city: t.city, school: t.school,
                folders: folders.map(f => ({ id: f.folderId, name: f.name }))
            };
        }));
        res.json(list);
    } catch (e) { res.status(500).json([]); }
});

// 4. СОЗДАНИЕ ПАПКИ
app.post('/api/create-folder', async (req, res) => {
    const { folderId, name, password, ownerId, isPrivate } = req.body;
    if (!folderId || !name) return res.status(400).json({ error: 'Заполните ID и Название' });

    try {
        const newFolder = new Folder({ folderId, ownerId, name, password: isPrivate ? null : password, isPrivate: !!isPrivate, files: [] });
        await newFolder.save();

        const log = new ActivityLog({
            userId: ownerId, actionType: "folder",
            text: isPrivate ? `Создан личный сейф документов "${name}"` : `Создана общая папка "${name}" (ID: ${folderId})`,
            timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString('ru-RU')
        });
        await log.save();
        res.json({ success: true, message: 'Папка создана!' });
    } catch(e) { res.status(400).json({ error: 'Такой ID папки уже существует!' }); }
});

// 5. ЗАГРУЗКА ФАЙЛА В ОБЛАКО
app.post('/api/add-file', async (req, res) => {
    const { folderId, fileType, fileName, fileData } = req.body;
    if(!folderId || !fileData) return res.status(400).json({ error: 'Данные отсутствуют' });

    try {
        const folder = await Folder.findOne({ folderId });
        if (!folder) return res.status(404).json({ error: 'Папка не найдена!' });

        const uploadRes = await cloudinary.uploader.upload(fileData, {
            resource_type: "auto", 
            folder: "dalaspace_files"
        });

        folder.files.push({ type: fileType, name: fileName, url: uploadRes.secure_url });
        await folder.save();

        res.json({ success: true, message: `Файл "${fileName}" загружен в облако!` });
    } catch (err) {
        res.status(500).json({ error: 'Ошибка облака Cloudinary' });
    }
});

// 6. ДОСТУП К ПАПКЕ
app.post('/api/access-folder', async (req, res) => {
    const { folderId, password, studentInfo } = req.body;
    try {
        const folder = await Folder.findOne({ folderId });
        if (!folder) return res.status(404).json({ success: false, message: 'Папка не найдена' });
        if (folder.isPrivate) return res.status(403).json({ success: false, message: 'Это личный сейф!' });

        if (folder.password === password) {
            const teacher = await User.findOne({ username: folder.ownerId });
            
            const log = new AccessLog({
                folderId, folderName: folder.name, teacherId: folder.ownerId,
                studentName: studentInfo.fullName || studentInfo.username,
                city: studentInfo.city, school: studentInfo.school, grade: studentInfo.grade,
                timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            });
            await log.save();

            res.json({ success: true, folder: { name: folder.name, files: folder.files }, author: teacher ? `${teacher.surname} ${teacher.name}` : "Преподаватель" });
        } else {
            res.status(401).json({ success: false, message: 'Неверный пароль' });
        }
    } catch(e) { res.status(500).json({ success: false }); }
});

// 7. АНАЛИТИКА
app.get('/api/analytics/:teacherId', async (req, res) => {
    try {
        const logs = await AccessLog.find({ teacherId: req.params.teacherId });
        res.json(logs);
    } catch(e) { res.json([]); }
});

// 8. ПРОФИЛЬ
app.get('/api/profile-data/:username', async (req, res) => {
    try {
        const folders = await Folder.find({ ownerId: req.params.username });
        const history = await ActivityLog.find({ userId: req.params.username });
        res.json({ folders, history });
    } catch(e) { res.json({ folders: [], history: [] }); }
});

app.listen(PORT, () => console.log(`Сервер DALASPACE запущен!`));