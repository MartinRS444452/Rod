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

echo "=== ЭТАП 2: Корректировка кода запуска в app.js ==="
node -e '
const fs = require("fs");
const file = "public/js/app.js";
let content = fs.readFileSync(file, "utf8");

// Ищем старый блок запуска
const oldBootCode = `setAuthMode(false);
boot();`;

const newBootCode = `setAuthMode(false);
// Автоматическая миграция со старого localStorage в IndexedDB перед стартом
(async () => {
    try {
        const oldData = localStorage.getItem("rod:localTree") || localStorage.getItem("treeData") || localStorage.getItem("tree");
        if (oldData) {
            const parsed = JSON.parse(oldData);
            const existing = await idb.get("localTree");
            if (!existing) {
                await idb.set("localTree", parsed);
                console.log("Миграция: данные успешно перенесены в IndexedDB.");
            }
        }
    } catch(e) {
        console.warn("Ошибка миграции:", e);
    }
    boot();
})();`;

if (content.includes("boot();") && !content.includes("idb.get")) {
    // Заменяем стандартный запуск на асинхронный с миграцией
    content = content.replace("setAuthMode(false);\nboot();", newBootCode);
    fs.writeFileSync(file, content, "utf8");
    console.log("Код запуска успешно обновлен с поддержкой IndexedDB!");
} else {
    console.log("Код запуска уже был обновлен или структура отличается.");
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
echo "Всё прошло успешно. Можешь проверять изменения через workflow на ПК."
