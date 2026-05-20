const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs'); 

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'database.json');

function readDB() {
    if (!fs.existsSync(DB_PATH)) {
        const initialData = { users: [], sharedFolders: {}, accessLogs: [], activityLogs: [] };
        fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2), 'utf8');
        return initialData;
    }
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return { users: [], sharedFolders: {}, accessLogs: [], activityLogs: [] };
    }
}

function writeDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Регулярные выражения для жесткой проверки на стороне сервера
const cyrillicRegex = /^[А-Яа-яЁё\s\-]+$/;
// Для школы разрешаем буквы (рус/eng), цифры, пробелы, дефисы, кавычки и знаки №
const schoolRegex = /^[А-Яа-яЁёA-Za-z0-9\s\-\.,№()""«»]+$/;

// 1. РЕГИСТРАЦИЯ
app.post('/api/register', async (req, res) => {
    const { username, password, role, city, school, name, surname, subject, fullName, grade } = req.body;
    
    // Проверка на заполненность абсолютно ВСЕХ полей
    if (!username || !password || !role || !city || !school) {
        return res.status(400).json({ success: false, message: 'Все основные поля должны быть заполнены!' });
    }
    if (role === 'teacher' && (!name || !surname || !subject)) {
        return res.status(400).json({ success: false, message: 'Заполните все поля личных данных учителя!' });
    }
    if (role === 'student' && (!fullName || !grade)) {
        return res.status(400).json({ success: false, message: 'Заполните все поля личных данных ученика!' });
    }

    // Проверка корректности языка
    if (!cyrillicRegex.test(city)) {
        return res.status(400).json({ success: false, message: 'Название города должно быть написано на русском языке!' });
    }
    if (!schoolRegex.test(school)) {
        return res.status(400).json({ success: false, message: 'Поле "Школа" заполнено некорректно (разрешены буквы, цифры и знак №)!' });
    }
    if (role === 'teacher') {
        if (!cyrillicRegex.test(name) || !cyrillicRegex.test(surname) || !cyrillicRegex.test(subject)) {
            return res.status(400).json({ success: false, message: 'Данные учителя (Имя, Фамилия, Предмет) вводятся только на русском!' });
        }
    }
    if (role === 'student' && !cyrillicRegex.test(fullName)) {
        return res.status(400).json({ success: false, message: 'ФИО ученика должно быть написано только на русском языке!' });
    }

    const db = readDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        return res.status(400).json({ success: false, message: 'Этот логин уже занят другим пользователем!' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        let newUser = { username, password: hashedPassword, role, city, school };
        if (role === 'teacher') {
            newUser.name = name; newUser.surname = surname; newUser.subject = subject;
        } else {
            newUser.fullName = fullName; newUser.grade = grade;
        }

        db.users.push(newUser);
        writeDB(db);
        res.json({ success: true, message: 'Регистрация успешно завершена!' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Внутренняя ошибка шифрования данных.' });
    }
});

// 2. АВТОРИЗАЦИЯ
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Заполните логин и пароль!' });
    }

    const db = readDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    
    if (!user) {
        return res.status(401).json({ success: false, message: 'Неверный логин или пароль!' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
        const { password, ...safeUserData } = user;
        res.json({ success: true, user: safeUserData });
    } else {
        res.status(401).json({ success: false, message: 'Неверный логин или пароль!' });
    }
});

// 3. ПОЛУЧЕНИЕ СПИСКА УЧИТЕЛЕЙ
app.get('/api/teachers', (req, res) => {
    const db = readDB();
    const teachersList = db.users.filter(u => u.role === 'teacher').map(t => {
        const teacherFolders = Object.keys(db.sharedFolders)
            .filter(key => db.sharedFolders[key].ownerId === t.username && !db.sharedFolders[key].isPrivate)
            .map(key => ({ id: key, name: db.sharedFolders[key].name }));
        return {
            username: t.username, name: t.name, surname: t.surname,
            subject: t.subject, city: t.city, school: t.school, folders: teacherFolders
        };
    });
    res.json(teachersList);
});

// 4. СОЗДАНИЕ ПАПКИ
app.post('/api/create-folder', (req, res) => {
    const { folderId, name, password, ownerId, isPrivate } = req.body;
    if (!folderId || !name) return res.status(400).json({ error: 'Заполните ID и Название папки' });
    
    const db = readDB();
    db.sharedFolders[folderId] = { 
        ownerId, name, password: isPrivate ? null : password, isPrivate: !!isPrivate, files: [] 
    };
    
    db.activityLogs.push({
        userId: ownerId, actionType: "folder",
        text: isPrivate ? `Создан личный сейф документов "${name}"` : `Создана общая папка "${name}" (ID: ${folderId})`,
        timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date().toLocaleDateString('ru-RU')
    });
    writeDB(db);
    res.json({ success: true, message: isPrivate ? 'Личная папка успешно добавлена в сейф!' : 'Защищенная папка создана!' });
});

// 5. ДОБАВЛЕНИЕ ФАЙЛА
app.post('/api/add-file', (req, res) => {
    const { folderId, fileType, fileName, fileData } = req.body;
    const db = readDB();
    const folder = db.sharedFolders[folderId];
    if (!folder) return res.status(404).json({ error: 'Папка с таким ID не найдена!' });

    folder.files.push({ type: fileType, name: fileName, url: fileData });
    writeDB(db);
    res.json({ success: true, message: `Файл "${fileName}" успешно сохранен!` });
});

// 6. ДОСТУП К ПАПКЕ ПО ПАРОЛЮ
app.post('/api/access-folder', (req, res) => {
    const { folderId, password, studentInfo } = req.body;
    const db = readDB();
    const folder = db.sharedFolders[folderId];
    
    if (!folder) return res.status(404).json({ success: false, message: 'Папка не найдена' });
    if (folder.isPrivate) return res.status(403).json({ success: false, message: 'Доступ запрещен. Это личный сейф учителя!' });

    if (folder.password === password) {
        const teacher = db.users.find(u => u.username === folder.ownerId);
        db.accessLogs.push({
            folderId, folderName: folder.name, studentName: studentInfo.fullName || studentInfo.username,
            city: studentInfo.city, school: studentInfo.school, grade: studentInfo.grade,
            timestamp: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
        });
        writeDB(db);
        res.json({ 
            success: true, folder: { name: folder.name, files: folder.files },
            author: teacher ? `${teacher.surname} ${teacher.name}` : "Преподаватель"
        });
    } else {
        res.status(401).json({ success: false, message: 'Неверный пароль' });
    }
});

// 7. АНАЛИТИКА
app.get('/api/analytics/:teacherId', (req, res) => {
    const { teacherId } = req.params;
    const db = readDB();
    const teacherLogs = db.accessLogs.filter(log => {
        const folder = db.sharedFolders[log.folderId];
        return folder && folder.ownerId === teacherId;
    });
    res.json(teacherLogs);
});

// 8. ДАННЫЕ ПРОФИЛЯ
app.get('/api/profile-data/:username', (req, res) => {
    const db = readDB();
    const userFolders = Object.keys(db.sharedFolders)
        .filter(key => db.sharedFolders[key].ownerId === req.params.username)
        .map(key => ({ id: key, ...db.sharedFolders[key] }));
    const userHistory = db.activityLogs.filter(log => log.userId === req.params.username);
    res.json({ folders: userFolders, history: userHistory });
});

app.listen(PORT, () => console.log(`Сервер стабильно работает онлайн на порту: ${PORT}`));