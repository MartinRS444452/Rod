#!/bin/bash
FILE="public/js/app.js"
echo "=== ПРОВЕРКА ФУНКЦИИ SETINPUTS ==="
grep -n -C 25 "const setInputs =" "$FILE"
