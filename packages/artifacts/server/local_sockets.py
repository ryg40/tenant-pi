"""Bounded Linux TCP table reads for local peer and listener ownership checks."""
import ipaddress
import os
import struct
import sys
import time

# Linux has the TCP tables /proc/net/tcp and /proc/net/tcp6, and each user can read them: False for IPv4, True for
# IPv6. macOS has none.
LINUX = sys.platform.startswith('linux')
TCP_TABLES = {False: '/proc/net/tcp', True: '/proc/net/tcp6'}
# The limits of one read of the tables: lines, seconds, and bytes of one line (the kernel prints 150 to 180). A limit
# stops the read with Unknown. peer_uid takes a line found before the stop as its answer; listener_inodes takes no
# answer from a read that stopped.
TABLE_LINES = 100_000
TABLE_SECONDS = 1.0
LINE_BYTES = 512
# The state LISTEN in the TCP tables, and the states of the listening rows: before Linux 4.4 the kernel printed the
# pending connection requests of a listener (state 03, SYN_RECV) among them (TCP_SEQ_STATE_OPENREQ of tcp_ipv4.c).
LISTEN = '0A'
LISTENING_ROWS = (LISTEN, '03')
# holds() reads no process with more open files than this.
FD_ENTRIES = 4096


class Unknown(Exception):
    """The TCP tables of Linux give no answer: none exists, one cannot be read, a line cannot be read, or the read
    passed a limit."""


def table_rows(tables=None, listening=False):
    """Yield (six, fields) for each line of the TCP tables, IPv4 first. The read goes line by line, so a caller that
    stops at its line reads no more. With `listening`, the read of a table ends at its first line that is not a
    listening row (LISTENING_ROWS; see listener_inodes). A table that does not exist has no lines (a kernel with no
    IPv6 has no tcp6). Raises Unknown when no table exists, a table cannot be read, a line is longer than LINE_BYTES,
    a listening row has too few fields, or the read passes TABLE_LINES lines or TABLE_SECONDS. `tables` maps six to a
    path; the default is TCP_TABLES."""
    deadline = time.monotonic() + TABLE_SECONDS
    lines = opened = 0
    for six, path in (TCP_TABLES if tables is None else tables).items():
        try:
            file = open(path, 'rb')
        except FileNotFoundError:
            continue
        except OSError:
            raise Unknown(path) from None
        opened += 1
        with file:
            try:
                file.readline(LINE_BYTES + 1)  # the head line
                while line := file.readline(LINE_BYTES + 1):
                    lines += 1
                    if len(line) > LINE_BYTES or lines > TABLE_LINES or time.monotonic() > deadline:
                        raise Unknown(path)
                    fields = line.decode('ascii', 'replace').split()
                    if listening:
                        if len(fields) < 10:
                            raise Unknown(path)
                        if fields[3] not in LISTENING_ROWS:
                            break
                    yield six, fields
            except OSError:
                raise Unknown(path) from None
    if not opened:
        raise Unknown('no TCP table')


def table_address(address, six):
    """The form of a (host, port) socket address in a TCP table of Linux, or None. The kernel prints each 32-bit
    word of the address as a number in the byte order of the host, and the port as a number. In the IPv6 table, an
    IPv4 address is the mapped address ::ffff:a.b.c.d."""
    host = ipaddress.ip_address(address[0])
    host = getattr(host, 'ipv4_mapped', None) or host
    if six:
        packed = host.packed if host.version == 6 else b'\0' * 10 + b'\xff\xff' + host.packed
    elif host.version == 4:
        packed = host.packed
    else:
        return None
    words = struct.unpack(f'={len(packed) // 4}I', packed)
    return ''.join(f'{word:08X}' for word in words) + f':{address[1]:04X}'


def peer_uid(peer, local, tables=None):
    """The user ID of the client socket of a TCP connection of this server: the line of a TCP table whose local
    address is `peer` and whose remote address is `local`. The read stops at that line. None when no line names that
    socket, when the tables give no answer (Unknown), or for a line that cannot be read."""
    try:
        wanted = {six: (table_address(peer, six), table_address(local, six)) for six in (False, True)}
        for six, fields in table_rows(tables):
            if len(fields) > 7 and (fields[1], fields[2]) == wanted[six]:
                return int(fields[7])
    except (Unknown, ValueError):
        pass
    return None


def listener_inodes(port, tables=None):
    """The inodes of all listening sockets on `port`: both tables, each address. Raises Unknown when the tables give
    no complete answer: a table that cannot be read, a limit of table_rows, or a listening row with too few fields.
    No partial answer is ever returned.

    The answer is complete with no read of the other sockets. Linux prints the listening sockets of a table before
    each other socket: tcp_seq_start and tcp_seq_next (net/ipv4/tcp_ipv4.c) walk the listening hash first, then the
    hash of the other sockets, and inet_hash (net/ipv4/inet_hashtables.c) puts only a socket in LISTEN into the
    listening hash. So the read of a table ends at its first line in another state, and many connections on a busy
    host do not count against TABLE_LINES. The kernel prints a table one page at a time and finds its place again for
    each page, so a listener that opens or closes during the read can shift the rows: the read is a snapshot."""
    wanted = f'{port:04X}'
    inodes = set()
    for _, fields in table_rows(tables, listening=True):
        if fields[3] == LISTEN and fields[1].rpartition(':')[2] == wanted:
            inodes.add(fields[9])
    return inodes


def holds(pid, inodes):
    """True when the process `pid` has each socket of `inodes` open: a link in /proc/<pid>/fd names an open socket as
    socket:[inode]. The walk stops when it found each one. False for a process that is gone or of another user, or
    when the walk passes FD_ENTRIES files before it found each one."""
    missing = set(inodes)
    try:
        with os.scandir(f'/proc/{pid}/fd') as entries:
            for count, entry in enumerate(entries):
                if not missing:
                    return True
                if count >= FD_ENTRIES:
                    return False
                try:
                    link = os.readlink(entry.path)
                except OSError:  # the file was closed meanwhile
                    continue
                if link.startswith('socket:[') and link.endswith(']'):
                    missing.discard(link[8:-1])
    except OSError:
        return False
    return not missing


def listener_owner(port, pid):
    """'owned', 'absent' or 'unknown'. A partial read never proves ownership or absence."""
    if LINUX:
        try:
            inodes = listener_inodes(port)
            if not inodes:
                return 'absent'
            if os.stat(f'/proc/{pid}').st_uid == os.getuid() and holds(pid, inodes):
                return 'owned'
        except (Unknown, OSError, OverflowError):
            pass
    return 'unknown'
