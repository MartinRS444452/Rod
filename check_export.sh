#!/bin/bash
FILE="public/js/app.js"
echo "=== ПРОВЕРКА КОДА ЭКСПОРТА ТЕМЫ ==="
grep -n -C 10 "data-export" "$FILE"
