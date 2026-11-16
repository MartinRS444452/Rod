#!/bin/bash
FILE="public/js/app.js"
echo "=== ПОИСК ЗАГРУЗКИ ЦВЕТОВ ==="
grep -n -C 5 "colors" "$FILE" | head -n 40
