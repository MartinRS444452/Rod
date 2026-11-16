#!/bin/bash

APP_FILE="public/js/app.js"

if [ ! -f "$APP_FILE" ]; then
    echo -e "\n\033[1;31m=========================================="
    echo -e " ОШИБКА: Файл $APP_FILE не найден!"
    echo -e "==========================================\033[0m\n"
    exit 1
fi

echo "=== ЭТАП 1: Создание резервной копии ==="
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups/backup_$TIMESTAMP"
mkdir -p "$BACKUP_DIR/public/js"
cp "$APP_FILE" "$BACKUP_DIR/public/js/app.js"
echo "Резервная копия сохранена в: $BACKUP_DIR/public/js/app.js"

echo "=== ЭТАП 2: Исправление импорта темы в app.js ==="
node -e '
const fs = require("fs");
const file = "public/js/app.js";
let content = fs.readFileSync(file, "utf8");

// Ищем старый блок обработки JSON при импорте темы
const oldBlock = `        const data = JSON.parse(code);
        closeModal();                           
        setTimeout(() => {
          if (data.colors) {
            setInputs(data.colors);             
            toast(\x27Тема "\x27 + (data.name || \x27Импорт\x27) + \x27" применена!\x27);                              
          } else {
            setInputs(data);                    
            toast(\x27Цвета применены!\x27);          
          }                                     
        }, 100);`;

// Новый блок: помимо загрузки в форму, сразу сохраняем в localStorage и применяем к стилям
const newBlock = `        const data = JSON.parse(code);
        closeModal();                           
        setTimeout(() => {
          const appliedColors = data.colors ? data.colors : data;
          setInputs(appliedColors);
          localStorage.setItem(\x27rod:customColors\x27, JSON.stringify(appliedColors));
          if (typeof applyCustomColors === \x27function\x27) applyCustomColors();
          if (typeof relayout === \x27function\x27) relayout();
          toast(\x27Тема "\x27 + (data.name || \x27Импорт\x27) + \x27" успешно применена!\x27);
        }, 100);`;

if (content.includes("JSON.parse(code);") && content.includes("setInputs")) {
    content = content.replace(oldBlock, newBlock);
    fs.writeFileSync(file, content, "utf8");
    console.log("Успех: логика импорта темы исправлена!");
} else {
    console.error("\n\033[1;31m==========================================");
    console.error(" ОШИБКА: Не удалось найти блок импорта для замены!");
    console.error("==========================================\033[0m\n");
    process.exit(1);
}
'

if [ $? -ne 0 ]; then
    echo -e "\n\033[1;31m=========================================="
    echo -e " СБОЙ ПРИ ИСПРАВЛЕНИИ КОДА!"
    echo -e "==========================================\033[0m\n"
    exit 1
fi

echo "=== ЭТАП 3: Проверка синтаксиса в песочнице (Node.js) ==="
node -c "$APP_FILE"

if [ $? -eq 0 ]; then
    echo "Песочница: синтаксических ошибок нет!"
else
    echo -e "\n\033[1;31m=========================================="
    echo -e " ОШИБКА СИНТАКСИСА! Восстанавливаем из бэкапа..."
    echo -e "==========================================\033[0m\n"
    cp "$BACKUP_DIR/public/js/app.js" "$APP_FILE"
    exit 1
fi

echo "=== ЭТАП 4: Готово! ==="
echo "Всё прошло успешно. Теперь темы из кода будут применяться мгновенно и сохраняться в приложении!"
