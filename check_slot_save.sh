#!/bin/bash
FILE="public/js/app.js"
echo "=== ПРОВЕРКА СОХРАНЕНИЯ ТЕМЫ В СЛОТ ==="
grep -n -C 20 "data-save" "$FILE"
