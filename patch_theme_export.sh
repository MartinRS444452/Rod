#!/bin/bash

APP_FILE="public/js/app.js"

if [ ! -f "$APP_FILE" ]; then
    echo "Ошибка: файл $APP_FILE не найден!"
    exit 1
fi

echo "=== ЭТАП 1: Создание резервной копии ==="
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups/backup_$TIMESTAMP"
mkdir -p "$BACKUP_DIR/public/js"
cp "$APP_FILE" "$BACKUP_DIR/public/js/app.js"
echo "Резервная копия сохранена в: $BACKUP_DIR/public/js/app.js"

echo "=== ЭТАП 2: Исправление кода экспорта тем в app.js ==="
node -e '
const fs = require("fs");
const file = "public/js/app.js";
let content = fs.readFileSync(file, "utf8");

// Ищем старый блок удаления картинки при экспорте
const oldExportCode = `      // Убираем картинку из кода темы, чтобы она не ломала копирование
      try {
        const parsed = JSON.parse(saved);
        if (parsed.colors) parsed.colors.bgImg = \x27\x27;
        saved = JSON.stringify(parsed);
      } catch(e) {}`;

if (content.includes("parsed.colors.bgImg = '';")) {
    content = content.replace(oldExportCode, "      // Картинка теперь сохраняется вместе с темой");
    fs.writeFileSync(file, content, "utf8");
    console.log("Успех: код экспорта тем обновлен, картинки теперь сохраняются!");
} else {
    console.log("Предупреждение: точный блок не найден, выполняем альтернативный поиск...");
    if (content.includes("parsed.colors.bgImg")) {
        content = content.replace(/if\s*\(parsed\.colors\)\s*parsed\.colors\.bgImg\s*=\s*['"].*?['"];?/g, "// Картинка сохраняется");
        fs.writeFileSync(file, content, "utf8");
        console.log("Успех: замена выполнена альтернативным способом!");
    } else {
        console.log("Строка с bgImg не обнаружена, возможно файл уже изменен.");
    }
}
'

echo "=== ЭТАП 3: Проверка синтаксиса в песочнице (Node.js) ==="
node -c "$APP_FILE"

if [ $? -eq 0 ]; then
    echo "Песочница: синтаксических ошибок нет!"
else
    echo "Ошибка синтаксиса! Возвращаем файл из бэкапа..."
    cp "$BACKUP_DIR/public/js/app.js" "$APP_FILE"
    exit 1
fi

echo "=== ЭТАП 4: Готово! ==="
echo "Всё прошло успешно. Можешь проверять изменения."
