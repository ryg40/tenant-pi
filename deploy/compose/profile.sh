# Shell profile of the Compose seat. The image build installs this file as
# /etc/profile.d/tenant-pi-seat.sh. The files .profile and .bashrc of the seat account read it.
# The file is for sh and for bash. A shell can read it more than one time.

# PATH: the launcher directory of the home and the Pi prefix of the image.
for seat_dir in "$HOME/.local/bin" /opt/pi-npm/bin; do
  case ":$PATH:" in *":$seat_dir:"*) ;; *) PATH="$seat_dir:$PATH" ;; esac
done
unset seat_dir
export PATH

# The gateway key. sshd gives no variable of the container to a login session.
# The entrypoint writes the value and the name of the variable to two files that only the seat account reads.
seat_run=/run/tenant-pi-seat
if [ -r "$seat_run/gateway-key" ] && [ -r "$seat_run/gateway-key.name" ]; then
  seat_key_name="$(cat "$seat_run/gateway-key.name")"
  case "$seat_key_name" in
    ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) ;;
    *) export "$seat_key_name=$(cat "$seat_run/gateway-key")" ;;
  esac
  unset seat_key_name
fi
unset seat_run

# An interactive SSH login starts the tmux session "seat", or attaches to it.
# The working directory is /projects when it is there, else the home directory.
# The image has the terminal descriptions of ncurses-base only. A TERM that the image does not know
# becomes xterm-256color. When tmux ends without an error, the login ends. When tmux fails, the shell stays.
seat_tmux() {
  if ! infocmp "${TERM:-}" >/dev/null 2>&1; then
    echo "seat: the image does not know TERM=${TERM:-}; TERM is now xterm-256color"
    TERM=xterm-256color
    export TERM
  fi
  seat_dir="$HOME"
  if [ -d /projects ]; then seat_dir=/projects; fi
  tmux new-session -A -s seat -c "$seat_dir" && exit
  unset seat_dir
  echo "seat: tmux failed; this shell has no tmux session"
}
case "$-" in
  *i*)
    if [ -n "${SSH_CONNECTION:-}" ] && [ -z "${TMUX:-}" ] && [ -t 0 ] && command -v tmux >/dev/null 2>&1; then
      seat_tmux
    fi
    ;;
esac
