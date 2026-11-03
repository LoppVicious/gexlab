"""GEX Lab - gestion de usuarios del servidor publicado.

  python3 usuarios.py crear <usuario>        crea el usuario (pide la contrasena dos veces)
  python3 usuarios.py crear <usuario> --generar   crea el usuario con una contrasena aleatoria y la muestra
  python3 usuarios.py contrasena <usuario>   cambia la contrasena (cierra sus sesiones abiertas)
  python3 usuarios.py desactivar <usuario>   bloquea el acceso sin borrar sus datos
  python3 usuarios.py activar <usuario>
  python3 usuarios.py borrar <usuario>       borra la cuenta (su carpeta de datos se conserva)
  python3 usuarios.py lista
"""
from __future__ import annotations

import getpass
import os
import secrets
import string
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import auth  # noqa: E402


def _ask() -> str:
    while True:
        p1 = getpass.getpass("Contrasena (minimo 10 caracteres): ")
        p2 = getpass.getpass("Repitela: ")
        if p1 != p2:
            print("No coinciden, prueba otra vez.")
            continue
        if len(p1) < 10:
            print("Demasiado corta.")
            continue
        return p1


def _generate() -> str:
    alphabet = string.ascii_letters + string.digits
    return "-".join("".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(4))


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in ("crear", "contrasena", "desactivar", "activar", "borrar", "lista"):
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "lista":
        users = auth.list_users()
        if not users:
            print("No hay usuarios.")
        for u, r in sorted(users.items()):
            print(f"  {u:<20} {'DESACTIVADO' if r.get('disabled') else 'activo':<12} creado {r.get('created', '?')}")
        return 0
    if len(argv) < 3:
        print("Falta el nombre de usuario.")
        return 1
    user = argv[2].strip().lower()
    try:
        if cmd == "crear":
            pw = _generate() if "--generar" in argv else _ask()
            auth.set_password(user, pw, create=True)
            # lista de partida: la del PC si se subio con la app
            base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watchlist.json")
            dest = auth.watchlist_path(user)
            if os.path.exists(base) and not os.path.exists(dest):
                import shutil
                shutil.copyfile(base, dest)
            print(f"Usuario {user} creado.")
            if "--generar" in argv:
                print(f"Contrasena: {pw}\n(apuntala ahora: no se guarda en ningun sitio legible)")
        elif cmd == "contrasena":
            pw = _generate() if "--generar" in argv else _ask()
            auth.set_password(user, pw)
            print(f"Contrasena de {user} cambiada; sus sesiones abiertas se han cerrado.")
            if "--generar" in argv:
                print(f"Contrasena: {pw}")
        elif cmd == "desactivar":
            auth.set_disabled(user, True)
            print(f"{user} desactivado.")
        elif cmd == "activar":
            auth.set_disabled(user, False)
            print(f"{user} activado.")
        elif cmd == "borrar":
            if input(f"Escribe {user} para confirmar: ").strip().lower() != user:
                print("Cancelado.")
                return 1
            auth.delete_user(user)
            print(f"{user} borrado.")
    except ValueError as e:
        print(f"Error: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
