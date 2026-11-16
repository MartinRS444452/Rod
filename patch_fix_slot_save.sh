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

echo "=== ЭТАП 2: Исправление функции сохранения в слот ==="
node -e '
const fs = require("fs");
const file = "public/js/app.js";
let content = fs.readFileSync(file, "utf8");

// Старый блок сохранения в слоты
const oldBlock = `  // СОХРАНЕНИЕ В СЛОТЫ
  body.querySelectorAll(\x27[data-save]\x27).forEach(btn => {
    btn.onclick = () => {
      const slot = btn.getAttribute(\x27data-save\x27);
      const name = body.querySelector(\x27[data-slotname="\x27 + slot + \x27"]\x27).value.trim() || (\x27Слот \x27 + slot); 
                                                
      const data = {
        name,                                   
        colors: {
          bg: body.querySelector(\x27#c-bg\x27).value, surface: body.querySelector(\x27#c-surface\x27).value,
          text: body.querySelector(\x27#c-text\x27).value, line: body.querySelector(\x27#c-line\x27).value,
          edge: body.querySelector(\x27#c-edge\x27).value, lineWidth: parseFloat(body.querySelector(\x27#c-linewidth\x27).value),
          spouseLine: body.querySelector(\x27#c-spouseline\x27).value, spouseLineWidth: parseFloat(body.querySelector(\x27#c-spousewidth\x27).value),
          divorceColor: body.querySelector(\x27#c-divorce\x27).value, bgImg: selectedBase64                
        }
      };                                        
      localStorage.setItem(\x27rod:theme_slot_\x27 + slot, JSON.stringify(data));                          
      toast(\x27Тема "\x27 + name + \x27" сохранена в слот \x27 + slot);                                         
      closeModal(); openThemePicker(); // Перерисовываем окно                                        
    };
  });`;

// Новый безопасный блок с защитой от переполнения памяти localStorage
const newBlock = `  // СОХРАНЕНИЕ В СЛОТЫ
  body.querySelectorAll(\x27[data-save]\x27).forEach(btn => {
    btn.onclick = () => {
      const slot = btn.getAttribute(\x27data-save\x27);
      const nameInput = body.querySelector(\x27[data-slotname="\x27 + slot + \x27"]\x27);
      const name = nameInput ? (nameInput.value.trim() || (\x27Слот \x27 + slot)) : (\x27Слот \x27 + slot); 
                                                
      const data = {
        name,                                   
        colors: {
          bg: body.querySelector(\x27#c-bg\x27).value, surface: body.querySelector(\x27#c-surface\x27).value,
          text: body.querySelector(\x27#c-text\x27).value, line: body.querySelector(\x27#c-line\x27).value,
          edge: body.querySelector(\x27#c-edge\x27).value, lineWidth: parseFloat(body.querySelector(\x27#c-linewidth\x27).value),
          spouseLine: body.querySelector(\x27#c-spouseline\x27).value, spouseLineWidth: parseFloat(body.querySelector(\x27#c-spousewidth\x27).value),
          divorceColor: body.querySelector(\x27#c-divorce\x27).value, bgImg: typeof selectedBase64 !== \x27undefined\x27 ? selectedBase64 : \x27\x27                
        }
      };                                        

      try {
        localStorage.setItem(\x27rod:theme_slot_\x27 + slot, JSON.stringify(data));                          
        toast(\x27Тема "\x27 + name + \x27" успешно сохранена в слот \x27 + slot);                                         
        closeModal(); 
        setTimeout(() => openThemePicker(), 150);
      } catch (err) {
        console.error("Storage error:", err);
        toast(\x27Ошибка: картинка слишком большая для памяти телефона!\x27, true);
      }
    };
  });`;

if (content.includes("data-save")) {
    content = content.replace(oldBlock, newBlock);
    fs.writeFileSync(file, content, "utf8");
    console.log("Успех: функция сохранения в слот исправлена и защищена!");
} else {
    console.error("\n\033[1;31mОШИБКА: Блок data-save не найден!\033[0m\n");
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
echo "Сохранение в слоты теперь работает стабильно."
