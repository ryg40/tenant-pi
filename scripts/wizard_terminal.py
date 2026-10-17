"""Small standard-library terminal, shared by every wizard adapter. JSON remains on stdout; UI uses stderr."""
import contextlib
import os
import select
import shutil
import signal
import sys
import termios
import tty

from scripts.validate import Invalid


class Cancelled(Exception):
    pass


class Terminal:
    def __init__(self, source=None, output=None):
        self.source = source or sys.stdin
        self.output = output or sys.stderr
        self.interactive = self.source.isatty() and self.output.isatty()

    def show(self, text):
        self.output.write(text + "\n")
        self.output.flush()

    def ask(self, label, default=""):
        self.show(label + (" [" + str(default) + "]" if default != "" else "") + ": (/back, /clear, /cancel)")
        line = self.source.readline(4097)
        if not line or len(line) > 4096:
            raise Cancelled()
        value = line.rstrip("\r\n")
        if value == "/cancel":
            raise Cancelled()
        if value == "/back":
            raise Back()
        if value == "/clear":
            return ""
        return value if value else default

    @contextlib.contextmanager
    def raw(self):
        fd = self.source.fileno()
        previous = termios.tcgetattr(fd)
        handlers = {}
        def stop(*_):
            raise Cancelled()
        try:
            for sig in (signal.SIGHUP, signal.SIGTERM):
                handlers[sig] = signal.signal(sig, stop)
            tty.setcbreak(fd)
            self.output.write("\x1b[?25l")
            yield
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
            try:
                termios.tcsetattr(fd, termios.TCSANOW, previous)
                self.output.write("\x1b[?25h\x1b[0m\n")
                self.output.flush()
            except (OSError, termios.error):
                pass

    def size(self):
        try:
            return os.get_terminal_size(self.output.fileno())
        except OSError:
            return shutil.get_terminal_size((80, 24))

    def key(self):
        fd = self.source.fileno()
        if not select.select([fd], [], [], 0.2)[0]:
            return "resize"
        value = os.read(fd, 1)
        if not value or value in (b"\x04", b"\x03"):
            raise Cancelled()
        if value == b"\x1b" and select.select([fd], [], [], 0.03)[0]:
            value += os.read(fd, 1)
            if value == b"\x1b[":
                while select.select([fd], [], [], 0.03)[0] and len(value) < 8:
                    part = os.read(fd, 1)
                    value += part
                    if not part or 0x40 <= part[0] <= 0x7e:
                        break
        return value.decode("ascii", "replace")

    def checklist(self, state):
        if not self.interactive:
            while True:
                for row in state.rows():
                    self.show(f"{row['group']} {row['number']} [{'x' if row['marked'] else ' '}] {row['id']} | {row['detected']} | {row['action']}")
                    self.show("  requires: " + ", ".join(row["requires"]) + "; details: " + ", ".join(row["details"]))
                value = self.ask("Number toggles; c Continue; b Back; q Cancel")
                if value == "c":
                    return
                if value in ("q", "b"):
                    raise Cancelled()
                try:
                    row = next(row for row in state.rows() if str(row["number"]) == value)
                    self.show(state.toggle(row["id"]))
                except (StopIteration, Invalid):
                    self.show("Choice unavailable; no selection changed.")
        cursor = 0
        message = "Core is required and locked. Optional selections do not authorize changes."
        with self.raw():
            while True:
                rows = state.rows()
                width, height = self.size()
                width, height = max(12, width), max(6, height)
                size = max(1, height - 7)
                start = max(0, min(cursor - size // 2, len(rows) - size))
                active = rows[cursor]
                lines = ["Core features / Optional features", "Arrows Move | Space Toggle | c Continue | b Back | q Cancel"]
                for row in rows[start:start + size]:
                    lines.append((">" if row is active else " ") + f"{row['number']} [{'x' if row['marked'] else ' '}] {row['id']} | {row['detected']} | {row['action']}")
                lines += [active["group"] + " | " + active["status"] + " | not verified",
                          "Requires: " + ", ".join(active["requires"]),
                          "Details (d): " + ", ".join(active["details"]), message]
                lines = lines[:height - 1] + ["c Go b Back q Cancel" if width >= 21 else "cGo bBack qX"]
                self.output.write("\x1b[H\x1b[2J" + "\r\n".join(line[:width - 1] for line in lines[:height]))
                self.output.flush()
                key = self.key()
                if key in ("\x1b[A", "k"):
                    cursor = max(0, cursor - 1)
                elif key in ("\x1b[B", "j"):
                    cursor = min(len(rows) - 1, cursor + 1)
                elif key in ("\x1b[6~",):
                    cursor = min(len(rows) - 1, cursor + size)
                elif key in ("\x1b[5~",):
                    cursor = max(0, cursor - size)
                elif key == " ":
                    try:
                        message = state.toggle(active["id"])
                    except Invalid as exc:
                        message = str(exc)
                elif key == "d":
                    # Recover all details without truncation through a paged terminal view.
                    self.page([active["id"], *([active["title"]] if active["title"] != active["id"] else []),
                               "Selected: " + str(active["marked"]),
                               "Detected: " + active["detected"], "Action: " + active["action"],
                               "Verification: " + active["verification"], *active["details"]], raw=True)
                elif key in ("c", "\r", "\n"):
                    return
                elif key in ("q", "b", "\x1b"):
                    raise Cancelled()

    def page(self, lines, raw=False):
        if not self.interactive:
            self.show("\n".join(lines))
            return
        if not raw:
            with self.raw():
                return self.page(lines, raw=True)
        position = 0
        while True:
            width, height = self.size()
            width = max(12, width) - 1
            wrapped = [part for line in lines for part in ([line[i:i + width] for i in range(0, len(line), width)] or [""])]
            size = max(1, height - 2)
            position = max(0, min(position, max(0, len(wrapped) - size)))
            self.output.write("\x1b[H\x1b[2J" + "\r\n".join(wrapped[position:position + size]) +
                              "\r\n" + ("Arrows/Space scroll; c Continue; b Back; q Cancel" if width >= 48 else "c Go b Back q Cancel" if width >= 20 else "cGo bBack qX")[:width])
            self.output.flush()
            key = self.key()
            if key in ("\x1b[B", "j"):
                position += 1
            elif key in ("\x1b[A", "k"):
                position -= 1
            elif key in (" ", "\x1b[6~"):
                position += size
            elif key in ("c", "\n", "\r"):
                return
            elif key == "b":
                raise Back()
            elif key in ("q", "\x1b"):
                raise Cancelled()


class Back(Exception):
    pass
