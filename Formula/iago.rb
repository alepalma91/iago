# typed: false
# frozen_string_literal: true

class Iago < Formula
  desc "AI-powered PR review daemon for macOS"
  homepage "https://github.com/alepalma91/iago"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/alepalma91/iago/releases/download/v#{version}/iago-#{version}-darwin-arm64.tar.gz"
      # sha256 "PLACEHOLDER" # Updated by CI on release
    else
      url "https://github.com/alepalma91/iago/releases/download/v#{version}/iago-#{version}-darwin-x86_64.tar.gz"
      # sha256 "PLACEHOLDER" # Updated by CI on release
    end
  end

  depends_on :macos
  depends_on "gh"

  def install
    bin.install "iago"
    bin.install "iago-bar" if File.exist?("iago-bar")
  end

  service do
    run [opt_bin/"iago", "start"]
    keep_alive true
    working_dir var/"iago"
    log_path var/"log/iago/daemon.log"
    error_log_path var/"log/iago/daemon.log"
    environment_variables HOME: Dir.home, PATH: "#{HOMEBREW_PREFIX}/bin:/usr/local/bin:/usr/bin:/bin"
  end

  def post_install
    (var/"iago").mkpath
    (var/"log/iago").mkpath
  end

  def caveats
    <<~EOS
      To configure iago for the first time:
        iago setup

      To start the daemon:
        brew services start iago
        # or: iago start

      To start the menu bar app on login:
        iago setup  # will offer to install the LaunchAgent

      Dashboard: http://localhost:1460
    EOS
  end

  test do
    assert_match "iago", shell_output("#{bin}/iago help")
  end
end
