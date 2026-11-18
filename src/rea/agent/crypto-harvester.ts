/**
 * In-memory crypto / traffic harvester — runs INSIDE the target process
 * (compiled with frida-compile, loaded by `ProcessInjector`).
 *
 * Hooks OpenSSL / BoringSSL (`SSL_read`, `SSL_write`,
 * `SSL_CTX_set_keylog_callback`) and Apple CommonCrypto (`CCCrypt`) and
 * streams plaintext buffers and session keys back to the host over the
 * Frida bus, before encryption / after decryption.
 *
 * Keylog lines are emitted in SSLKEYLOGFILE format so a capture can be
 * opened in Wireshark. Nothing is written to disk in the target.
 *
 * NOTE on lifetimes: the keylog `NativeCallback` is kept on the instance.
 * A callback that is only a local variable can be garbage-collected while
 * the target still holds its pointer, which crashes the process.
 */
import { findExport } from './util.js';

export class MemoryCryptoHarvester {
  private keylogCallback: NativeCallback<'void', ['pointer', 'pointer']> | null = null;
  private setKeylogFn: NativeFunction<void, [NativePointer, NativePointer]> | null = null;

  public startHarvesting(): void {
    this.hookTlsReadWrite();
    this.hookSslKeyLog();
    this.hookAppleCommonCrypto();
  }

  /** Plaintext flowing through SSL_write (out) and SSL_read (in). */
  private hookTlsReadWrite(): void {
    const sslWritePtr = findExport(null, 'SSL_write');
    const sslReadPtr = findExport(null, 'SSL_read');

    if (sslWritePtr !== null) {
      Interceptor.attach(sslWritePtr, {
        onEnter(args) {
          const len = args[2].toInt32();
          if (len <= 0) return;
          const bytes = args[1].readByteArray(len);
          if (bytes !== null) {
            send({ type: 'TLS_PLAINTEXT_OUT', length: len }, bytes);
          }
        },
      });
    }

    if (sslReadPtr !== null) {
      Interceptor.attach(sslReadPtr, {
        onEnter(args) {
          this.buf = args[1];
        },
        onLeave(retval) {
          const len = retval.toInt32();
          if (len <= 0 || !this.buf) return;
          const bytes = (this.buf as NativePointer).readByteArray(len);
          if (bytes !== null) {
            send({ type: 'TLS_PLAINTEXT_IN', length: len }, bytes);
          }
        },
      });
    }
  }

  /** TLS session secrets via the OpenSSL/BoringSSL keylog callback. */
  private hookSslKeyLog(): void {
    const setKeylogPtr = findExport(null, 'SSL_CTX_set_keylog_callback');
    const sslNewPtr = findExport(null, 'SSL_new');
    if (setKeylogPtr === null || sslNewPtr === null) return;

    const setKeylogFn = new NativeFunction(setKeylogPtr, 'void', ['pointer', 'pointer']);
    // Kept on the instance: the target keeps this pointer after we return.
    const keylogCallback = new NativeCallback(
      (_ssl: NativePointer, linePtr: NativePointer) => {
        const keyLine = linePtr.readUtf8String();
        if (keyLine !== null) {
          send({ type: 'SSL_SECRET_KEY', keylog: keyLine });
        }
      },
      'void',
      ['pointer', 'pointer'],
    );
    this.setKeylogFn = setKeylogFn;
    this.keylogCallback = keylogCallback;

    Interceptor.attach(sslNewPtr, {
      onEnter(args) {
        // SSL_new(ctx) — register the keylog callback on that context.
        setKeylogFn(args[0], keylogCallback);
      },
    });
  }

  /** Symmetric keys on macOS / iOS (CCCrypt). */
  private hookAppleCommonCrypto(): void {
    const ccCryptPtr = findExport('libcommonCrypto.dylib', 'CCCrypt');
    if (ccCryptPtr === null) return;

    Interceptor.attach(ccCryptPtr, {
      onEnter(args) {
        this.operation = args[0].toInt32(); // 0 = kCCEncrypt, 1 = kCCDecrypt
        this.algorithm = args[1].toInt32();
        const keyLength = args[4].toInt32();
        const keyBytes = args[3].readByteArray(keyLength);
        send(
          {
            type: 'SYMMETRIC_KEY_INTERCEPTED',
            operation: this.operation === 0 ? 'ENCRYPT' : 'DECRYPT',
            algorithm: this.algorithm,
          },
          keyBytes,
        );
      },
    });
  }
}
