#!/bin/bash
# Test of deploy/vm/setup.sh's persist_ports: it adds TCP 80 and 443 to a saved iptables ruleset (Oracle's
# /etc/iptables/rules.v4) and leaves every other line alone, Docker's included. Runs anywhere: no root, no
# iptables (iptables-restore --test is a stand-in that says whether the file looks loadable).
#   tests/deploy/firewall.sh
set -u
R=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
eval "$(sed -n '/^persist_ports() {/,/^}/p' "$R/deploy/vm/setup.sh")"
mkdir "$T/bin"
cat >"$T/bin/iptables-restore" <<'EOF'
#!/bin/sh
# the stand-in: every table ends with COMMIT, and RESTORE_FAILS=1 makes it refuse
[ "${RESTORE_FAILS:-}" = 1 ] && exit 1
awk '/^\*/ { open++ } /^COMMIT/ { open-- } END { exit open != 0 }'
EOF
chmod +x "$T/bin/iptables-restore"
PATH="$T/bin:$PATH"

# Oracle's Ubuntu image rules (abridged), then with Docker's rules saved into them as `netfilter-persistent save` did
STOCK='# iptables configuration for Oracle Cloud Infrastructure
*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:InstanceServices - [0:0]
-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p icmp -j ACCEPT
-A INPUT -i lo -j ACCEPT
-A INPUT -p udp --sport 123 -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
-A FORWARD -j REJECT --reject-with icmp-host-prohibited
-A OUTPUT -d 169.254.0.0/16 -j InstanceServices
COMMIT'
DOCKER='*nat
:PREROUTING ACCEPT [0:0]
:DOCKER - [0:0]
-A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-A DOCKER -d 172.17.0.2/32 ! -i docker0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.17.0.2:80
COMMIT
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:DOCKER - [0:0]
-A FORWARD -j DOCKER
-A INPUT -i lo -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
-A DOCKER -d 172.17.0.2/32 ! -i docker0 -o docker0 -p tcp -m tcp --dport 80 -j ACCEPT
COMMIT'
OURS='-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT
-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT'

failed=0 n=0
check() {   # name, condition (a command)
    n=$((n + 1))
    if "${@:2}"; then echo "ok   $1"; else echo "FAIL $1"; failed=$((failed + 1)); fi
}
# the lines a file gained (diff's additions), and whether it lost or changed any
added() { diff "$1" "$2" | sed -n 's/^> //p'; }
removed() { diff "$1" "$2" | grep -c '^<'; }

f=$T/rules.v4
printf '%s\n' "$STOCK" >"$f"; cp "$f" "$T/stock"
out=$(persist_ports "$f")
check "adds 80 and 443 to Oracle's rules" [ "$(added "$T/stock" "$f")" = "$OURS" ]
check "... and changes nothing else" [ "$(removed "$T/stock" "$f")" = 0 ]
check "... at the top of INPUT, before its REJECT" [ "$(grep -m1 -n -- '--dport 80 -j ACCEPT' "$f" | cut -d: -f1)" -lt "$(grep -n -- '-A INPUT -j REJECT' "$f" | cut -d: -f1)" ]
check "... keeps the previous file" cmp -s "$T/stock" "$f.cricket07-before"
check "... and says so" grep -q "added ports 80 443" <<<"$out"
cp "$f" "$T/once"; rm -f "$f.cricket07-before"
persist_ports "$f" >/dev/null
check "a second run leaves the file alone" cmp -s "$T/once" "$f"
check "... and makes no backup" [ ! -e "$f.cricket07-before" ]

printf '%s\n' "$STOCK" | sed 's/^-A INPUT -i lo -j ACCEPT$/&\n-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT/' >"$f"; cp "$f" "$T/doc"
persist_ports "$f" >/dev/null
check "a port already open as Oracle's docs write it is left as it is" [ "$(added "$T/doc" "$f")" = "-A INPUT -p tcp -m tcp --dport 443 -j ACCEPT" ]

printf '%s\n' "$DOCKER" >"$f"; cp "$f" "$T/docker"
persist_ports "$f" >/dev/null
check "with Docker's rules in the file: only the two lines are added" [ "$(added "$T/docker" "$f")" = "$OURS" ] && [ "$(removed "$T/docker" "$f")" = 0 ]
check "... in the filter table, not nat" [ "$(awk '/^\*filter/ { t = 1 } /--dport 443 -j ACCEPT/ { print t + 0; exit }' "$f")" = 1 ]

printf '*nat\n:PREROUTING ACCEPT [0:0]\nCOMMIT\n' >"$f"; cp "$f" "$T/nofilter"
out=$(persist_ports "$f")
check "no filter table: the file is left alone" cmp -s "$T/nofilter" "$f"
check "... and the player is told" grep -q "couldn't add ports 80 443" <<<"$out"
check "... with nothing left behind" [ ! -e "$f.cricket07-new" ]

printf '%s\n' "$STOCK" >"$f"
out=$(RESTORE_FAILS=1 persist_ports "$f")
check "a file iptables-restore refuses isn't written" cmp -s "$T/stock" "$f"
check "... and the player is told" grep -q "couldn't add" <<<"$out"

echo
[ $failed = 0 ] && echo "all $n passed" || { echo "$failed of $n failed"; exit 1; }
