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
write_files:
  - path: /etc/ssh/sshd_config.d/99-hamooncloud.conf
    owner: root:root
    permissions: '0644'
    content: |
      PasswordAuthentication yes
      PermitRootLogin yes
      KbdInteractiveAuthentication yes
      UsePAM yes
runcmd:
  - ssh-keygen -A
  - systemctl enable ssh.service || systemctl enable sshd.service || true
  - /usr/sbin/sshd -t
  - systemctl restart ssh.service || systemctl restart sshd.service
`;
}

module.exports = { buildRootPasswordCloudInit };
