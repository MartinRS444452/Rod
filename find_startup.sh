#!/bin/bash

FILE="public/js/app.js"

if [ ! -f "$FILE" ]; then
    echo "Ошибка: файл $FILE не найден в текущей папке!"
    exit 1
fi

echo "=========================================="
echo " ПОИСК ТОЧЕК ЗАПУСКА И ИНИЦИАЛИЗАЦИИ В APP.JS"
echo "=========================================="
echo ""

# Ищем строки, где приложение запускается (DOMContentLoaded, init, onload, addEventListener)
grep -n -C 6 -E "DOMContentLoaded|init|onload|window\.|addEventListener" "$FILE"

echo ""
echo "=========================================="
echo " КОНЕЦ ПОИСКА. Скопируй текст выше и отправь мне."
echo "=========================================="
