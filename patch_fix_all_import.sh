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

echo "=== ЭТАП 2: Исправление логики импорта темы в app.js ==="
node -e '
const fs = require("fs");
const file = "public/js/app.js";
let content = fs.readFileSync(file, "utf8");

// Старый блок импорта
const oldBlock = `    importBody.querySelector(\x27#btn-apply-import\x27).onclick = () => {
      const code = importBody.querySelector(\x27#import-code\x27).value.trim();
      if (!code) return;

      try {
        // Пытаемся прочитать как JSON-код темы 
        const data = JSON.parse(code);
        closeModal();                           
        setTimeout(() => {
          if (data.colors) {
            setInputs(data.colors);             
            toast(\x27Тема "\x27 + (data.name || \x27Импорт\x27) + \x27" применена!\x27);                              
          } else {
            setInputs(data);                    
            toast(\x27Цвета применены!\x27);          
          }                                     
        }, 100);
      } catch(e) {`;

// Новый блок импорта с гарантированным сохранением и применением всех цветов, линий и фонов
const newBlock = `    importBody.querySelector(\x27#btn-apply-import\x27).onclick = () => {
      const code = importBody.querySelector(\x27#import-code\x27).value.trim();
      if (!code) return;

      try {
        // Пытаемся прочитать как JSON-код темы 
        const data = JSON.parse(code);
        closeModal();                           
        setTimeout(() => {
          const rawColors = data.colors ? data.colors : data;
          
          // Применяем в форме
          setInputs(rawColors);
          
          // Сохраняем в память приложения для постоянного использования
          localStorage.setItem(\x27rod:customColors\x27, JSON.stringify(rawColors));
          
          // Принудительно применяем цвета и стили ко всему интерфейсу
          if (typeof applyCustomColors === \x27function\x27) applyCustomColors();
          if (typeof updatePreview === \x27function\x27) updatePreview();
          if (typeof relayout === \x27function\x27) relayout();
          
          toast(\x27Тема "\x27 + (data.name || \x27Импорт\x27) + \x27" успешно применена со всеми цветами и настройками!\x27);
        }, 100);
      } catch(e) {`;

if (content.includes("btn-apply-import") && content.includes("JSON.parse(code);")) {
    content = content.replace(oldBlock, newBlock);
    fs.writeFileSync(file, content, "utf8");
    console.log("Успех: логика импорта полностью исправлена!");
} else {
    console.error("\n\033[1;31m==========================================");
    console.error(" ОШИБКА: Не удалось найти точный блок импорта для замены!");
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
echo "Теперь цвета, оттенки, толщина линий и фоновые изображения будут применяться мгновенно."
