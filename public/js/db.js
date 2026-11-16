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
