function escapeCloudInitPassword(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildRootPasswordCloudInit(rootPassword) {
  const password = escapeCloudInitPassword(rootPassword);
  return `#cloud-config
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
users:
  - name: root
    password: "${password}"
    type: text
runcmd:
  - sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config.d/*.conf || true
  - sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config.d/*.conf || true
  - systemctl restart ssh || systemctl restart sshd || true
`;
}

module.exports = { buildRootPasswordCloudInit };
