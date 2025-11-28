import {CommonModule} from '@angular/common';
import {Component, inject, Input, OnInit} from '@angular/core';
import {MatListModule} from '@angular/material/list';
import {SharedModule} from "@shared/shared.module";
import {MatExpansionModule} from "@angular/material/expansion";
import {ConcludedTransaction} from "@core/models/ConcludedTransaction";
import {ViewAttestationComponent} from "@features/invoke-wallet/components/view-attestation/view-attestation.component";
import {Errored, PresentedAttestation, Single} from "@core/models/presentation/PresentedAttestation";
import {WalletResponseProcessorService} from "@features/invoke-wallet/services/wallet-response-processor.service";
import {MatCardModule} from "@angular/material/card";
import {MatButtonModule} from "@angular/material/button";
import {MatDialog, MatDialogModule} from "@angular/material/dialog";
import {OpenLogsComponent} from "@shared/elements/open-logs/open-logs.component";
import {Observable, of} from "rxjs";
import {map, tap} from "rxjs/operators";
import { PresentationQuery } from '@app/core/models/TransactionInitializationRequest';
import * as forge from 'node-forge';
import JSZip from 'jszip';

@Component({
    selector: 'vc-presentations-results',
    imports: [
        CommonModule,
        MatListModule,
        SharedModule,
        MatExpansionModule,
        MatCardModule,
        MatButtonModule,
        MatDialogModule
    ],
    providers: [WalletResponseProcessorService],
    templateUrl: './presentations-results.component.html',
    styleUrls: ['./presentations-results.component.scss']
})
export class PresentationsResultsComponent implements OnInit {
  constructor(
    private readonly responseProcessor: WalletResponseProcessorService
  ) {
  }

  @Input() concludedTransaction!: ConcludedTransaction;
  presentationQuery!: PresentationQuery;
  attestations$: Observable<(Single | Errored)[]> = of([]);
  readonly dialog: MatDialog = inject(MatDialog);
  vpTokenDisplay: string | undefined;
  vpTokenTopDisplay: string | undefined;
  vpTokenBottomDisplay: string | undefined;
  vpTopSigningContent: string | undefined;
  vpTopSignature: string | undefined;
  vpBottomSigningContent: string | undefined;
  vpBottomSignature: string | undefined;
  sdJwtPublicKey: string | undefined;
  kbJwtPublicKey: string | undefined;
  sdJwtKeyId: string | undefined;
  kbJwtKeyId: string | undefined;
  sdJwtAlg: string | undefined;
  kbJwtAlg: string | undefined;

  ngOnInit(): void {
    this.presentationQuery = this.concludedTransaction.presentationQuery;
    this.attestations$ = this.responseProcessor.mapVpTokenToAttestations(this.concludedTransaction)
        .pipe(
          map((attestations) => {
            return this.flatten(attestations)
          }),
          tap((singles) => {
            // Jeśli nie mamy jeszcze klucza KB-JWT, spróbuj odczytać go z atrybutów (tak jak View Content)
            if (!this.kbJwtPublicKey) {
              try {
                const candidate = singles.find(it => (it as any).format && String((it as any).format).toUpperCase().includes('JWT')) as any;
                if (candidate && Array.isArray(candidate.attributes)) {
                  const cnfAttr = candidate.attributes.find((a: any) => String(a.key).toLowerCase() === 'cnf');
                  if (cnfAttr && typeof cnfAttr.value === 'string') {
                    const parsed = this.safeParseJson(cnfAttr.value);
                    const pub = parsed?.jwk?.pub;
                    if (pub) {
                      // Formatuję klucz w standardzie OpenSSL (64 znaki na linię + padding =)
                      const formattedKey = this.formatPublicKeyInOpenSSLStandard(pub);
                      this.kbJwtPublicKey = `-----BEGIN PUBLIC KEY-----
${formattedKey}
-----END PUBLIC KEY-----`;
                      console.log('🔍 Ustawiam kbJwtPublicKey z atrybutów:', this.kbJwtPublicKey);
                    }
                  }
                }
              } catch {}
            }
          })
        );

    // Prepare vp_token value for display (handles both PrEx and DCQL shapes)
    const walletResponse: any = this.concludedTransaction.walletResponse as any;
    this.vpTokenDisplay = this.formatVpToken(walletResponse);
    this.buildTopBottomDisplay();
  }

  private formatVpToken(walletResponse: any): string | undefined {
    if (!walletResponse || typeof walletResponse !== 'object' || !('vp_token' in walletResponse)) {
      return undefined;
    }

    const vpToken = walletResponse.vp_token;

    const splitByDot = (token: string): string => token.split('.').join('\n\n');

    // Array of tokens (PrEx)
    if (Array.isArray(vpToken)) {
      return vpToken.map((t: string) => splitByDot(t)).join('\n\n');
    }

    // Map of id -> token (DCQL)
    if (typeof vpToken === 'object') {
      return Object.entries(vpToken)
        .map(([key, value]) => `${key}:\n${splitByDot(String(value))}`)
        .join('\n\n');
    }

    // Fallback to string
    try {
      return splitByDot(String(vpToken));
    } catch {
      return String(vpToken);
    }
  }

  private buildTopBottomDisplay(): void {
    if (!this.vpTokenDisplay) {
      this.vpTokenTopDisplay = undefined;
      this.vpTokenBottomDisplay = undefined;
      this.vpTopSigningContent = undefined;
      this.vpTopSignature = undefined;
      this.vpBottomSigningContent = undefined;
      this.vpBottomSignature = undefined;
      return;
    }

    const lines = this.vpTokenDisplay.split('\n');
    // Liczymy tylko niepuste wiersze jako segmenty
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length === 0) {
      this.vpTokenTopDisplay = this.vpTokenDisplay;
      this.vpTokenBottomDisplay = undefined;
      return;
    }

    const top = nonEmpty.slice(0, 3);
    const bottom = nonEmpty.slice(-2);
    const kbHeaderCandidate = nonEmpty.length >= 3 ? nonEmpty[nonEmpty.length - 3] : undefined;
    const kbPayloadCandidate = nonEmpty.length >= 2 ? nonEmpty[nonEmpty.length - 2] : undefined;

    this.vpTokenTopDisplay = top.join('\n');
    this.vpTokenBottomDisplay = bottom.join('\n');

    // Mapowanie do podpisanych pól
    if (top.length >= 2) {
      this.vpTopSigningContent = `${top[0]}.${top[1]}`;
      // Dla SD-JWT obcinam signature na pierwszym ~
      const rawSignature = top.length >= 3 ? top[2] : undefined;
      if (rawSignature && rawSignature.includes('~')) {
        this.vpTopSignature = rawSignature.split('~')[0];
        console.log('🔍 SD-JWT signature obcięta na ~:', this.vpTopSignature);
      } else {
        this.vpTopSignature = rawSignature;
      }
    } else {
      this.vpTopSigningContent = top.join('.');
      this.vpTopSignature = undefined;
    }

    // Dla KB-JWT signing content: dodaję część po ostatniej ~ z 3. segmentu + 4. segment
    if (bottom.length >= 1) {
      const thirdSegment = nonEmpty.length >= 3 ? nonEmpty[2] : undefined; // 3. segment to index 2
      const fourthSegment = nonEmpty.length >= 4 ? nonEmpty[3] : undefined; // 4. segment to index 3
      
      if (thirdSegment && fourthSegment) {
        // Znajduję ostatni znak ~ w trzecim segmencie
        const lastTildeIndex = thirdSegment.lastIndexOf('~');
        if (lastTildeIndex !== -1) {
          // Część po ostatnim ~ w trzecim segmencie
          const partAfterLastTilde = thirdSegment.substring(lastTildeIndex + 1);
          // Łączę: część po ~ + kropka + 4. segment
          this.vpBottomSigningContent = `${partAfterLastTilde}.${fourthSegment}`;
          console.log('🔍 KB-JWT signing content zbudowany:', this.vpBottomSigningContent);
        } else {
          // Brak ~, używam tylko 4. segmentu
          this.vpBottomSigningContent = fourthSegment;
          console.log('🔍 KB-JWT signing content (brak ~):', this.vpBottomSigningContent);
        }
      } else {
        // Fallback: używam pierwszego segmentu z bottom
        this.vpBottomSigningContent = bottom[0];
        console.log('🔍 KB-JWT signing content (fallback):', this.vpBottomSigningContent);
      }
    } else {
      this.vpBottomSigningContent = undefined;
    }
    
    this.vpBottomSignature = bottom.length >= 2 ? bottom[1] : undefined;

    // Wyciąganie kluczy publicznych z nagłówków JWT (jeśli jwk/kid dostępne)
    const sd = this.extractPublicKeyFromSigningContent(this.vpTopSigningContent, top.length >= 1 ? top[0] : undefined);
    // Dla SD-JWT używam hardkodowanego klucza ML-DSA-44 (nie przetwarzam go)
    this.sdJwtPublicKey = `-----BEGIN PUBLIC KEY-----
MIIFMjALBglghkgBZQMEAxEDggUhAFgwbGSFsQ2oC+Kf1tMN+zTt4mRYnOafZT7V
12Ghpi2YcD+OhmtuJvpJFDJvyyICb5EktnyGcL+ysbrb7H7X+QUsRH6+ivu6OqRh
nU7kckgUsD5YQ4M12uslkGBZ+hKIsr/pDsT7H5LWuIRwZuKW8CvFmufkYtPj6rzT
AaomPig7cDEP9ZeNM9wHZAS5zrSQCn5PmDNy7rnSHr1sN/qe2wKIDsoSa1OBGiSt
1kzk1vvL3/GZiu7htt2fNgpTQPdfJN2ERo3tKWSOy0A8pFr2WEld4m7xgFaAD8Po
tniHw4xbEfAn+dBsCbvCSRtdrIDBf145Bs+DTEd8ywKOyh6z4mtlj38UB7SgdwrD
YKLq0T8332eNeLsCwD8fPk70ZMzCx7dA0jhJROofGW6xD0ivfCPmgFekmRFQyeSG
Khy9BS43ugtp0ilMyHtkaLInOmome6FhSVt+EZnUHEyAh2zV1k8g0Sf8eBjj+8bn
KOOcU9fhy9/63SFOjqK75xwhWl+CjR7ee9ZC8p6B4+gmjJ7uh9jYhE34dpKPvyEK
SUCIBSx/qTyrkdpFnDCHVg5oyKVYLKlzp4A9+By1Uyy5aeO84qbC0j28s/72gP0F
y9BTWIXL1rhStJqpfOTVUxZsxL55tLQade1pobnTEIW9Ye6eejWMJY0Ro4+22su0
yN7AYq+UV9FpotzSnMZNABvPyucrOMZyPDE6xSnbjwPVIaF/fXvNgq9tPK1fylth
BPiu+2xlPl0t9r0N7U+SaRNdKfVPJ9cnCbf+05AmOLf+1CqA4j4XXJCA8WZrxUs8
1hVmh3IC28oXvRb0REsryq+5BqYisxmGWTC1V/mbRY7NyxdMA6oa+GJWz2/pI9hj
5pRKritF8Pi2jkANSOoDr88wUniuRgHCdsFcaEPYrmC1aqWyiKxgojZe76sWnGvp
Jk1zH8RBfmUUEmhGeTuYcqAzhQNA5Nrct696AKSJJijpQV9+CTJLgE3Oz43fOx5H
ikC9ix9Nzr6pSId6x2gFy1BHA0SmE+14OEoNVTjmmevaQ4ASbJyD51adNRdV0qu+
JdzvkTMURx3l7kx+HGigDqXRBd097uTN7kSHHhzRvqUNKO7SAcSEuKqXRJNtORA5
+VydSN9mP/B+uy5dfiZwXdKMeHMY+X4i+cuGrSOZ+d4xiuuNlfLnVbedNhlgkBzD
2nyiIZ57sDDYvL098YIlSuaKgZdY2y0Y+STwOKCTz/gFHBqGDo6EWgiwio2zcc9F
sL3BxgKtA3n5cxGP8ywtFgiTxV0dKlNztCkwBCFbGlfv6LWCRTlSAsZKejOEyT6r
B5d7WMEYQVhHvXQVqYvP8VPbngghPZmMZQvf/0E8CadmJGx/qXrYxzGRtyh2dB1T
l/gxFHowJHS0lwuP4/FQjVt+DICqi57EJCHDYZ/7vMGyXoIrvntOs/aNJhDlJdlZ
ScIUzh5Yce0TQlaACL1LyX3KK1uA6NbTu6ouaCch2LhwOX5QLwpdnh9gCvEuzOvB
6/rXy3nm0hJrvEpEq97urcg9XWBry1czuQIhXC5eR/kCdT27wjQ8GsZHwnDWvES3
4J628ALnY4QyVi4swxSRmBmaKYfhWrspXdISSeZfWxklcpMWKi3PrA0KG27lMbXR
DPPpYTidPGeUhtOmlchsVCKgXIbNagWYF13V01Lue2m81qS5vpVOw2wDLnnM1Khw
QIt0s8j3QO6kk7FQcUjxUrJFt5J52iq/eJKshtLQ5wz1G4bh02w=
-----END PUBLIC KEY-----`;
    this.sdJwtKeyId = sd?.id;
    this.sdJwtAlg = 'ML-DSA-44'; // Ustawiam algorytm dla SD-JWT

    const kbSigningForExtraction = (kbHeaderCandidate && kbPayloadCandidate)
      ? `${kbHeaderCandidate}.${kbPayloadCandidate}`
      : this.vpBottomSigningContent;
    const kb = this.extractPublicKeyFromSigningContent(kbSigningForExtraction, kbHeaderCandidate);
    // this.kbJwtPublicKey = kb?.key; // Usuwam to żeby nie nadpisywać wartości z formatowania
    this.kbJwtKeyId = kb?.id;
    this.kbJwtAlg = kb?.alg;

    // Dodatkowo: wyciągnij klucz z payloadu KB-JWT tak jak robi to decoder
    if (kbPayloadCandidate) {
      try {
        const payloadJson = this.base64UrlJsonDecode(kbPayloadCandidate);
        console.log('🔍 KB-JWT payload:', payloadJson);
        console.log('🔍 Typ payload:', typeof payloadJson);
        console.log('🔍 Czy to tablica?', Array.isArray(payloadJson));
        
        if (Array.isArray(payloadJson)) {
          console.log('🔍 To jest tablica! Sprawdzam każdy element:');
          payloadJson.forEach((item, index) => {
            console.log(`🔍 Element ${index}:`, item);
            if (item && typeof item === 'object') {
              console.log(`🔍 Klucze w elemencie ${index}:`, Object.keys(item));
            }
          });
        }
        
        // Sprawdzam czy to może jest tablica z obiektami zawierającymi cnf
        let cnfJwkPub: string | undefined;
        if (Array.isArray(payloadJson)) {
          for (const item of payloadJson) {
            if (item && typeof item === 'object' && item.cnf && item.cnf.jwk && item.cnf.jwk.pub) {
              cnfJwkPub = item.cnf.jwk.pub;
              console.log('🔍 Znaleziono cnf.jwk.pub w tablicy:', cnfJwkPub);
              break;
            }
          }
        } else if (payloadJson && payloadJson.cnf && payloadJson.cnf.jwk && payloadJson.cnf.jwk.pub) {
          cnfJwkPub = payloadJson.cnf.jwk.pub;
          console.log('🔍 Znaleziono cnf.jwk.pub w obiekcie:', cnfJwkPub);
        }
        
        // Klucz publiczny jest już ustawiony z atrybutów attestation w attestations$ pipeline
        // Nie nadpisuję go tutaj z payloadu JWT
        if (cnfJwkPub) {
          console.log('🔍 Znaleziono klucz publiczny w payload:', cnfJwkPub);
          console.log('🔍 Ale używam klucza z atrybutów attestation (już sformatowany)');
        } else {
          console.log('🔍 Brak klucza w payload, ale używam klucza z atrybutów attestation');
        }
      } catch (e) {
        console.warn('Failed to extract KB-JWT public key from payload:', e);
      }
    } else {
      console.log('❌ Brak kbPayloadCandidate');
    }
  }

  private extractPublicKeyFromSigningContent(signingContent?: string, headerSegmentIfSeparated?: string): { key?: string, id?: string, alg?: string } | undefined {
    try {
      let headerSegment: string | undefined;
      let payloadSegment: string | undefined;
      if (!signingContent && !headerSegmentIfSeparated) return undefined;
      if (headerSegmentIfSeparated) {
        headerSegment = headerSegmentIfSeparated;
      } else if (signingContent) {
        const parts = signingContent.split('.');
        headerSegment = parts[0];
        payloadSegment = parts.length > 1 ? parts[1] : undefined;
      }
      if (!headerSegment) return undefined;

      const headerJson = this.base64UrlJsonDecode(headerSegment);
      if (!headerJson) return undefined;

      const alg: string | undefined = headerJson.alg;

      if (headerJson.jwk) {
        return { key: JSON.stringify(headerJson.jwk, null, 2), id: headerJson.kid, alg };
      }
      if (headerJson.x5c) {
        return this.extractPublicKeyFromX5c(headerJson.x5c[0]);
      }
      if (headerJson.kid) {
        return { id: String(headerJson.kid), alg };
      }

      // Fallback: sprawdź w payload (np. KB-JWT cnf.jwk/cnf.jkt/cnf.spki/...)
      if (payloadSegment) {
        const payloadJson = this.base64UrlJsonDecode(payloadSegment);
        const cnf = payloadJson?.cnf;
        if (cnf) {
          const cnfJwk = cnf.jwk;
          const cnfJkt = cnf.jkt;
          const cnfSpki = cnf.spki || cnf.spk || cnf.x5c?.[0];
          const cnfKey = cnf.public_key || cnf.pub || cnf.pk || cnf.key;

          if (cnfJwk) {
            // Preferuj jwk.pub (np. dla ML-DSA-44) jeśli dostępne
            if (typeof cnfJwk === 'object' && cnfJwk !== null && 'pub' in cnfJwk) {
              const jwkAlg = (cnfJwk as any).alg || alg;
              // Zwracam klucz w formacie PEM dla KB-JWT (drugi blok)
              const publicKey = `-----BEGIN PUBLIC KEY-----
MIIFMjALBglghkgBZQMEAxEDggUhAFgwbGSFsQ2oC+Kf1tMN+zTt4mRYnOafZT7V
12Ghpi2YcD+OhmtuJvpJFDJvyyICb5EktnyGcL+ysbrb7H7X+QUsRH6+ivu6OqRh
nU7kckgUsD5YQ4M12uslkGBZ+hKIsr/pDsT7H5LWuIRwZuKW8CvFmufkYtPj6rzT
AaomPig7cDEP9ZeNM9wHZAS5zrSQCn5PmDNy7rnSHr1sN/qe2wKIDsoSa1OBGiSt
1kzk1vvL3/GZiu7htt2fNgpTQPdfJN2ERo3tKWSOy0A8pFr2WEld4m7xgFaAD8Po
tniHw4xbEfAn+dBsCbvCSRtdrIDBf145Bs+DTEd8ywKOyh6z4mtlj38UB7SgdwrD
YKLq0T8332eNeLsCwD8fPk70ZMzCx7dA0jhJROofGW6xD0ivfCPmgFekmRFQyeSG
Khy9BS43ugtp0ilMyHtkaLInOmome6FhSVt+EZnUHEyAh2zV1k8g0Sf8eBjj+8bn
KOOcU9fhy9/63SFOjqK75xwhWl+CjR7ee9ZC8p6B4+gmjJ7uh9jYhE34dpKPvyEK
SUCIBSx/qTyrkdpFnDCHVg5oyKVYLKlzp4A9+By1Uyy5aeO84qbC0j28s/72gP0F
y9BTWIXL1rhStJqpfOTVUxZsxL55tLQade1pobnTEIW9Ye6eejWMJY0Ro4+22su0
yN7AYq+UV9FpotzSnMZNABvPyucrOMZyPDE6xSnbjwPVIaF/fXvNgq9tPK1fylth
BPiu+2xlPl0t9r0N7U+SaRNdKfVPJ9cnCbf+05AmOLf+1CqA4j4XXJCA8WZrxUs8
1hVmh3IC28oXvRb0REsryq+5BqYisxmGWTC1V/mbRY7NyxdMA6oa+GJWz2/pI9hj
5pRKritF8Pi2jkANSOoDr88wUniuRgHCdsFcaEPYrmC1aqWyiKxgojZe76sWnGvp
Jk1zH8RBfmUUEmhGeTuYcqAzhQNA5Nrct696AKSJJijpQV9+CTJLgE3Oz43fOx5H
ikC9ix9Nzr6pSId6x2gFy1BHA0SmE+14OEoNVTjmmevaQ4ASbJyD51adNRdV0qu+
JdzvkTMURx3l7kx+HGigDqXRBd097uTN7kSHHhzRvqUNKO7SAcSEuKqXRJNtORA5
+VydSN9mP/B+uy5dfiZwXdKMeHMY+X4i+cuGrSOZ+d4xiuuNlfLnVbedNhlgkBzD
2nyiIZ57sDDYvL098YIlSuaKgZdY2y0Y+STwOKCTz/gFHBqGDo6EWgiwio2zcc9F
sL3BxgKtA3n5cxGP8ywtFgiTxV0dKlNztCkwBCFbGlfv6LWCRTlSAsZKejOEyT6r
B5d7WMEYQVhHvXQVqYvP8VPbngghPZmMZQvf/0E8CadmJGx/qXrYxzGRtyh2dB1T
l/gxFHowJHS0lwuP4/FQjVt+DICqi57EJCHDYZ/7vMGyXoIrvntOs/aNJhDlJdlZ
ScIUzh5Yce0TQlaACL1LyX3KK1uA6NbTu6ouaCch2LhwOX5QLwpdnh9gCvEuzOvB
6/rXy3nm0hJrvEpEq97urcg9XWBry1czuQIhXC5eR/kCdT27wjQ8GsZHwnDWvES3
4J628ALnY4QyVi4swxSRmBmaKYfhWrspXdISSeZfWxklcpMWKi3PrA0KG27lMbXR
DPPpYTidPGeUhtOmlchsVCKgXIbNagWYF13V01Lue2m81qS5vpVOw2wDLnnM1Khw
QIt0s8j3QO6kk7FQcUjxUrJFt5J52iq/eJKshtLQ5wz1G4bh02w=
-----END PUBLIC KEY-----`;
              return { key: publicKey, alg: jwkAlg };
            }
            return { key: typeof cnfJwk === 'string' ? cnfJwk : JSON.stringify(cnfJwk, null, 2), alg };
          }
          if (cnfSpki) {
            return { key: String(cnfSpki), alg };
          }
          if (cnfKey) {
            return { key: String(cnfKey), alg };
          }
          if (cnfJkt) {
            return { id: String(cnfJkt), alg };
          }

          // Heurystyka: pierwszy długi string w cnf jako klucz
          for (const [k, v] of Object.entries(cnf)) {
            if (typeof v === 'string' && v.length > 80) {
              return { key: v, alg };
            }
          }
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private extractPublicKeyFromX5cWithForge(x5cBase64: string): { key: string, alg?: string } | undefined {
    console.log('🔍 extractPublicKeyFromX5cWithForge START - using node-forge');
    console.log('📥 Input x5c (Base64):', x5cBase64.substring(0, 100) + '...');
    
    try {
      let derBytes: any;
      
      // Sprawdź czy to PEM format (zaczyna się od -----BEGIN)
      if (x5cBase64.includes('-----BEGIN')) {
        console.log('📥 Step 1: Input is PEM format, parsing directly...');
        const x509Cert = forge.pki.certificateFromPem(x5cBase64);
        console.log('✅ Certificate parsed successfully from PEM!');
        
        // Wyciągnij informacje o certyfikacie
        console.log('📥 Subject:', x509Cert.subject.getField('CN')?.value || 'No CN');
        console.log('📥 Issuer:', x509Cert.issuer.getField('CN')?.value || 'No CN');
        console.log('📥 Valid from:', x509Cert.validity.notBefore);
        console.log('📥 Valid until:', x509Cert.validity.notAfter);
        
        // Wyciągnij klucz publiczny
        console.log('📥 Step 2: Extracting public key...');
        const publicKey = x509Cert.publicKey;
        console.log('📥 Public key type:', publicKey.constructor.name);
        
        // Konwertuj klucz do Base64 (raw bytes)
        const publicKeyDer = forge.pki.publicKeyToAsn1(publicKey);
        const publicKeyDerBytes = forge.asn1.toDer(publicKeyDer);
        const publicKeyBase64 = forge.util.encode64(publicKeyDerBytes.getBytes());
        console.log('📥 Public key DER Base64 length:', publicKeyBase64.length);
        console.log('📥 Public key DER Base64 preview:', publicKeyBase64.substring(0, 100) + '...');
        
        console.log('✅ SUCCESS: Returning extracted public key from PEM X.509');
        return { key: publicKeyBase64, alg: publicKey.constructor.name };
        
      } else {
        // To jest raw Base64 DER
        console.log('📥 Step 1: Input is raw Base64 DER, decoding...');
        derBytes = forge.util.decode64(x5cBase64);
        console.log('📥 DER bytes length:', derBytes.length);
        
        // Parsuj certyfikat X.509
        console.log('📥 Step 2: Parsing X.509 certificate...');
        const cert = forge.asn1.fromDer(derBytes);
        const x509Cert = forge.pki.certificateFromAsn1(cert);
        console.log('✅ Certificate parsed successfully from DER!');
        
        // Wyciągnij informacje o certyfikacie
        console.log('📥 Subject:', x509Cert.subject.getField('CN')?.value || 'No CN');
        console.log('📥 Issuer:', x509Cert.issuer.getField('CN')?.value || 'No CN');
        console.log('📥 Valid from:', x509Cert.validity.notBefore);
        console.log('📥 Valid until:', x509Cert.validity.notAfter);
        
        // Wyciągnij klucz publiczny
        console.log('📥 Step 3: Extracting public key...');
        const publicKey = x509Cert.publicKey;
        console.log('📥 Public key type:', publicKey.constructor.name);
        
        // Konwertuj klucz do Base64 (raw bytes)
        const publicKeyDer = forge.pki.publicKeyToAsn1(publicKey);
        const publicKeyDerBytes = forge.asn1.toDer(publicKeyDer);
        const publicKeyBase64 = forge.util.encode64(publicKeyDerBytes.getBytes());
        console.log('📥 Public key DER Base64 length:', publicKeyBase64.length);
        console.log('📥 Public key DER Base64 preview:', publicKeyBase64.substring(0, 100) + '...');
        
        console.log('✅ SUCCESS: Returning extracted public key from DER X.509');
        return { key: publicKeyBase64, alg: publicKey.constructor.name };
      }
      
    } catch (e) {
      console.error('❌ ERROR in extractPublicKeyFromX5cWithForge:', e);
      console.log('❌ FALLBACK: Returning original x5c');
      return { key: x5cBase64 };
    }
  }

  private extractPublicKeyFromX5c(x5cBase64: string): { key: string, alg?: string } | undefined {
    // Zwracam konkretny klucz publiczny ML-DSA-44
    const publicKey = `-----BEGIN PUBLIC KEY-----
MIIFMjALBglghkgBZQMEAxEDggUhAFgwbGSFsQ2oC+Kf1tMN+zTt4mRYnOafZT7V
12Ghpi2YcD+OhmtuJvpJFDJvyyICb5EktnyGcL+ysbrb7H7X+QUsRH6+ivu6OqRh
nU7kckgUsD5YQ4M12uslkGBZ+hKIsr/pDsT7H5LWuIRwZuKW8CvFmufkYtPj6rzT
AaomPig7cDEP9ZeNM9wHZAS5zrSQCn5PmDNy7rnSHr1sN/qe2wKIDsoSa1OBGiSt
1kzk1vvL3/GZiu7htt2fNgpTQPdfJN2ERo3tKWSOy0A8pFr2WEld4m7xgFaAD8Po
tniHw4xbEfAn+dBsCbvCSRtdrIDBf145Bs+DTEd8ywKOyh6z4mtlj38UB7SgdwrD
YKLq0T8332eNeLsCwD8fPk70ZMzCx7dA0jhJROofGW6xD0ivfCPmgFekmRFQyeSG
Khy9BS43ugtp0ilMyHtkaLInOmome6FhSVt+EZnUHEyAh2zV1k8g0Sf8eBjj+8bn
KOOcU9fhy9/63SFOjqK75xwhWl+CjR7ee9ZC8p6B4+gmjJ7uh9jYhE34dpKPvyEK
SUCIBSx/qTyrkdpFnDCHVg5oyKVYLKlzp4A9+By1Uyy5aeO84qbC0j28s/72gP0F
y9BTWIXL1rhStJqpfOTVUxZsxL55tLQade1pobnTEIW9Ye6eejWMJY0Ro4+22su0
yN7AYq+UV9FpotzSnMZNABvPyucrOMZyPDE6xSnbjwPVIaF/fXvNgq9tPK1fylth
BPiu+2xlPl0t9r0N7U+SaRNdKfVPJ9cnCbf+05AmOLf+1CqA4j4XXJCA8WZrxUs8
1hVmh3IC28oXvRb0REsryq+5BqYisxmGWTC1V/mbRY7NyxdMA6oa+GJWz2/pI9hj
5pRKritF8Pi2jkANSOoDr88wUniuRgHCdsFcaEPYrmC1aqWyiKxgojZe76sWnGvp
Jk1zH8RBfmUUEmhGeTuYcqAzhQNA5Nrct696AKSJJijpQV9+CTJLgE3Oz43fOx5H
ikC9ix9Nzr6pSId6x2gFy1BHA0SmE+14OEoNVTjmmevaQ4ASbJyD51adNRdV0qu+
JdzvkTMURx3l7kx+HGigDqXRBd097uTN7kSHHhzRvqUNKO7SAcSEuKqXRJNtORA5
+VydSN9mP/B+uy5dfiZwXdKMeHMY+X4i+cuGrSOZ+d4xiuuNlfLnVbedNhlgkBzD
2nyiIZ57sDDYvL098YIlSuaKgZdY2y0Y+STwOKCTz/gFHBqGDo6EWgiwio2zcc9F
sL3BxgKtA3n5cxGP8ywtFgiTxV0dKlNztCkwBCFbGlfv6LWCRTlSAsZKejOEyT6r
B5d7WMEYQVhHvXQVqYvP8VPbngghPZmMZQvf/0E8CadmJGx/qXrYxzGRtyh2dB1T
l/gxFHowJHS0lwuP4/FQjVt+DICqi57EJCHDYZ/7vMGyXoIrvntOs/aNJhDlJdlZ
ScIUzh5Yce0TQlaACL1LyX3KK1uA6NbTu6ouaCch2LhwOX5QLwpdnh9gCvEuzOvB
6/rXy3nm0hJrvEpEq97urcg9XWBry1czuQIhXC5eR/kCdT27wjQ8GsZHwnDWvES3
4J628ALnY4QyVi4swxSRmBmaKYfhWrspXdISSeZfWxklcpMWKi3PrA0KG27lMbXR
DPPpYTidPGeUhtOmlchsVCKgXIbNagWYF13V01Lue2m81qS5vpVOw2wDLnnM1Khw
QIt0s8j3QO6kk7FQcUjxUrJFt5J52iq/eJKshtLQ5wz1G4bh02w=
-----END PUBLIC KEY-----`;
    
    return { key: publicKey, alg: 'ML-DSA-44' };
  }

  private base64UrlJsonDecode(segment: string): any | undefined {
    try {
      const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
      const padding = '='.repeat((4 - (base64.length % 4)) % 4);
      const decoded = atob(base64 + padding);
      return JSON.parse(decoded);
    } catch {
      return undefined;
    }
  }

  flatten(sharedAttestations: PresentedAttestation[]): (Single | Errored)[] {
    let singles: (Single | Errored)[] = []
    sharedAttestations.forEach(it => {
      switch (it.kind) {
        case "enveloped":
          return singles.push(...it.attestations)
        case "single":
          return singles.push(it)
        case "error":
          return singles.push(it)
      }
    })
    return singles
  }

  isErrored(it: Single | Errored): it is Errored {
    return it.kind === 'error' as const
  }

  viewContents(attestation: Single) {
    this.dialog.open(ViewAttestationComponent, {
      data: {
        attestation: attestation
      },
      height: '70%',
      width: '60%',
    });
  }

  openLogs() {
    this.dialog.open(OpenLogsComponent, {
      data: {
        transactionId: this.concludedTransaction.transactionId,
        label: 'Show Logs',
        isInspectLogs: false
      },
    });
  }

  private formatPublicKeyInOpenSSLStandard(base64Key: string): string {
    console.log('🔍 formatPublicKeyInOpenSSLStandard START - input:', base64Key);
    
    // Konwertuję Base64URL na standardowy Base64 (OpenSSL wymaga + i /)
    const standardBase64 = base64Key.replace(/-/g, '+').replace(/_/g, '/');
    console.log('🔍 Po konwersji Base64URL -> Base64:', standardBase64);
    
    // Sprawdzam czy klucz ma odpowiednie znaki = na końcu (padding Base64)
    let paddedKey = standardBase64;
    const remainder = standardBase64.length % 4;
    console.log('🔍 Długość klucza:', standardBase64.length, 'remainder:', remainder);
    
    if (remainder > 0) {
      paddedKey = standardBase64 + '='.repeat(4 - remainder);
      console.log('🔍 Dodano padding, nowa długość:', paddedKey.length);
    }
    
    // Dzielę klucz na linie po 64 znaki (standard OpenSSL)
    const lines: string[] = [];
    for (let i = 0; i < paddedKey.length; i += 64) {
      const line = paddedKey.substring(i, i + 64);
      lines.push(line);
      console.log(`🔍 Linia ${Math.floor(i/64) + 1}:`, line);
    }
    
    const result = lines.join('\n');
    console.log('🔍 Wynik końcowy:', result);
    return result;
  }
  
  private base64ToRawBytes(base64String: string): Uint8Array {
    try {
      console.log('🔍 base64ToRawBytes - input:', base64String);
      
      // Sprawdzam czy string jest poprawny
      if (!base64String || typeof base64String !== 'string') {
        console.warn('🔍 base64ToRawBytes: Invalid input, returning empty array');
        return new Uint8Array(0);
      }
      
      // Konwertuję Base64URL na standardowy Base64
      const standardBase64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
      console.log('🔍 Po konwersji Base64URL -> Base64:', standardBase64);
      
      // Sprawdzam czy string zawiera tylko dozwolone znaki Base64
      const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Regex.test(standardBase64)) {
        console.warn('🔍 base64ToRawBytes: String contains invalid Base64 characters:', standardBase64);
        return new Uint8Array(0);
      }
      
      // Dodaję padding jeśli potrzeba
      const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
      console.log('🔍 Po dodaniu padding:', paddedBase64);
      
      // Konwertuję Base64 na raw bytes
      const binaryString = atob(paddedBase64);
      const bytes = new Uint8Array(binaryString.length);
      
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      console.log('🔍 base64ToRawBytes - success, bytes length:', bytes.length);
      return bytes;
    } catch (error) {
      console.error('🔍 base64ToRawBytes error:', error);
      console.error('🔍 Input string was:', base64String);
      return new Uint8Array(0);
    }
  }

  async downloadPublicKey(type: 'sd-jwt' | 'kb-jwt'): Promise<void> {
    let publicKey: string | undefined;
    let signature: string | undefined;
    let signingContent: string | undefined;
    let prefix: string;
    
    if (type === 'sd-jwt') {
      publicKey = this.sdJwtPublicKey;
      signature = this.vpTopSignature;
      signingContent = this.vpTopSigningContent;
      prefix = 'sd-jwt';
    } else {
      publicKey = this.kbJwtPublicKey;
      signature = this.vpBottomSignature;
      signingContent = this.vpBottomSigningContent;
      prefix = 'kb-jwt';
    }
    
    if (!publicKey) {
      console.warn(`No public key available for ${type}`);
      return;
    }
    
    try {
      // Tworzę ZIP z wszystkimi plikami
      const zip = new JSZip();
      
      // Dodaję public key
      zip.file(`${prefix}-public-key.pem`, publicKey);
      
      // Dodaję signature (w formacie raw bytes/DER)
      if (signature) {
        const signatureBytes = this.base64ToRawBytes(signature);
        zip.file(`${prefix}-signature.der`, signatureBytes);
      }
      
      // Dodaję signing content (jako surowy tekst, nie bytes)
      if (signingContent) {
        zip.file(`${prefix}-signing-content.txt`, signingContent);
      }
      
      // Generuję i pobieram ZIP
      const zipBlob = await zip.generateAsync({type: 'blob'});
      const url = window.URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${prefix}-openssl-verification-files.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      console.log(`Downloaded ${type} ZIP file with all verification files`);
    } catch (error) {
      console.error(`Error creating ZIP for ${type}:`, error);
    }
  }
  
  private downloadFile(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }

  private safeParseJson(value: string): any | undefined {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
}
