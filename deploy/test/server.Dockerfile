# A stand-in for the real server, for deploy/test/e2e.sh only: Debian with
# systemd as PID 1, sshd, and the one-time setup from the runbook (user
# iroha owning /opt/iroha, the sudoers rule, journal access). Password login
# is deliberately left ON in sshd, with a password set, so the test shows the
# deploy script refuses passwords on its own. Never expose this container.
FROM debian:bookworm-slim

ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server sudo curl ca-certificates procps \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/getty* /etc/systemd/system/getty.target.wants/* \
 && systemctl mask systemd-logind.service getty.target console-getty.service \
 && systemctl enable ssh

RUN useradd --create-home --shell /bin/bash iroha \
 && echo 'iroha:e2e-not-a-real-password' | chpasswd \
 && usermod -aG systemd-journal iroha \
 && install -d -o iroha -g iroha -m 755 /opt/iroha \
 && install -d -o iroha -g iroha -m 700 /home/iroha/.ssh \
 && install -d -m 700 /root/.ssh \
 && printf '%s\n' 'iroha ALL=(root) NOPASSWD: /usr/bin/systemctl start iroha, /usr/bin/systemctl stop iroha, /usr/bin/systemctl restart iroha' > /etc/sudoers.d/iroha-deploy \
 && chmod 440 /etc/sudoers.d/iroha-deploy \
 && printf 'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/e2e.conf

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
