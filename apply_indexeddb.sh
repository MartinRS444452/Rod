#!/bin/bash

# Убедимся, что мы находимся в корне проекта
if [ ! -d "public" ]; then
    echo "Ошибка: папка public не найдена. Запусти скрипт из корня репозитория Rod!"
    exit 1
fi

echo "=== ЭТАП 1: Создание резервной копии ==="
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups/backup_$TIMESTAMP"
mkdir -p "$BACKUP_DIR/public/js"

if [ -f "public/js/app.js" ]; then
    cp "public/js/app.js" "$BACKUP_DIR/public/js/app.js"
    echo "Резервная копия app.js сохранена в: $BACKUP_DIR/public/js/"
else
    echo "Предупреждение: public/js/app.js не найден, но продолжаем..."
fi

echo "=== ЭТАП 2: Создание модуля IndexedDB (public/js/db.js) ==="
cat << 'DBEOF' > public/js/db.js
/**
 * Модуль для работы с IndexedDB в приложении Rod.
 * Заменяет localStorage для хранения больших объемов данных.
 */

const DB_NAME = 'RodAppDatabase';
const STORE_NAME = 'treeStore';
const DB_VERSION = 1;

export function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = (event) => reject(event.target.error);
        request.onsuccess = (event) => resolve(event.target.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

export async function saveData(key, data) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(data, key);
        request.onsuccess = () => resolve(true);
        request.onerror = (event) => reject(event.target.error);
    });
}

export async function getData(key) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(key);
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

export async function migrateFromLocalStorage() {
    try {
        const oldData = localStorage.getItem('treeData') || localStorage.getItem('tree');
        if (oldData) {
            const parsed = JSON.parse(oldData);
            const existing = await getData('treeData');
            if (!existing) {
                await saveData('treeData', parsed);
                console.log('Миграция: данные успешно перенесены из localStorage в IndexedDB.');
            }
        }
    } catch (error) {
        console.warn('Ошибка миграции из localStorage:', error);
    }
}
DBEOF

echo "Файл public/js/db.js успешно создан."

echo "=== ЭТАП 3: Проверка синтаксиса в песочнице (Node.js) ==="
node -c public/js/db.js

if [ $? -eq 0 ]; then
    echo "Песочница: синтаксических ошибок в db.js не обнаружено!"
else
    echo "Ошибка: в созданном файле обнаружены синтаксические проблемы!"
    exit 1
fi

echo "=== ЭТАП 4: Готово к синхронизации ==="
echo "Бэкап сделан, модуль создан и проверен. Можешь коммитить изменения и пушить на GitHub!"
