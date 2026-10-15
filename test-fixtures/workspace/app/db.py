"""A deliberately unsafe query. The extension's tests point events at it."""
import sqlite3

def find_user(name):
    cur = sqlite3.connect("app.db").cursor()
    sql = "SELECT * FROM users WHERE name = '%s'" % name
    cur.execute(sql)
    return cur.fetchall()
