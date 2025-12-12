import { CommonModule } from '@angular/common';
import { Component, inject, Input, OnInit } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { SharedModule } from '@shared/shared.module';
import { MatExpansionModule } from '@angular/material/expansion';
import { ConcludedTransaction } from '@core/models/ConcludedTransaction';
import { ViewAttestationComponent } from '@features/invoke-wallet/components/view-attestation/view-attestation.component';
import { Errored, PresentedAttestation, Single } from '@core/models/presentation/PresentedAttestation';
import { WalletResponseProcessorService } from '@features/invoke-wallet/services/wallet-response-processor.service';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { OpenLogsComponent } from '@shared/elements/open-logs/open-logs.component';
import { Observable, of } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { PresentationQuery } from '@app/core/models/TransactionInitializationRequest';
import JSZip from 'jszip';

interface ParsedAsn1Node {
  tag: number;
  length: number;
  start: number;
  end: number;
  offset: number;
  value: Uint8Array;
  children?: ParsedAsn1Node[];
}

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
	constructor (
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

  ngOnInit (): void {
  	this.presentationQuery = this.concludedTransaction.presentationQuery;
  	this.attestations$ = this.responseProcessor.mapVpTokenToAttestations(this.concludedTransaction)
  		.pipe(
  			map((attestations) => {
  				return this.flatten(attestations);
  			}),
  			tap((singles) => this.hydrateKbPublicKeyFromAttestations(singles))
  		);

  	// Prepare vp_token value for display (handles both PrEx and DCQL shapes)
  	const walletResponse: any = this.concludedTransaction.walletResponse as any;
  	this.vpTokenDisplay = this.formatVpToken(walletResponse);
  	this.buildTopBottomDisplay();
  }

  private formatVpToken (walletResponse: any): string | undefined {
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

  private buildTopBottomDisplay (): void {
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

  	if (top.length >= 2) {
  		this.vpTopSigningContent = `${top[0]}.${top[1]}`;
  		const rawSignature = top.length >= 3 ? top[2] : undefined;
  		if (rawSignature && rawSignature.includes('~')) {
  			this.vpTopSignature = rawSignature.split('~')[0];
  		} else {
  			this.vpTopSignature = rawSignature;
  		}
  	} else {
  		this.vpTopSigningContent = top.join('.');
  		this.vpTopSignature = undefined;
  	}

  	if (bottom.length >= 1) {
  		const thirdSegment = nonEmpty.length >= 3 ? nonEmpty[2] : undefined;
  		const fourthSegment = nonEmpty.length >= 4 ? nonEmpty[3] : undefined;

  		if (thirdSegment && fourthSegment) {
  			const lastTildeIndex = thirdSegment.lastIndexOf('~');
  			if (lastTildeIndex !== -1) {
  				const partAfterLastTilde = thirdSegment.substring(lastTildeIndex + 1);
  				this.vpBottomSigningContent = `${partAfterLastTilde}.${fourthSegment}`;
  			} else {
  				this.vpBottomSigningContent = fourthSegment;
  			}
  		} else {
  			this.vpBottomSigningContent = bottom[0];
  		}
  	} else {
  		this.vpBottomSigningContent = undefined;
  	}

  	this.vpBottomSignature = bottom.length >= 2 ? bottom[1] : undefined;

  	const sd = this.extractPublicKeyFromSigningContent(this.vpTopSigningContent, top.length >= 1 ? top[0] : undefined);
  	this.sdJwtPublicKey = sd?.key;
  	this.sdJwtKeyId = sd?.id;
  	this.sdJwtAlg = 'ML-DSA-44';

  	const kbSigningForExtraction = (kbHeaderCandidate && kbPayloadCandidate) ?
  		`${kbHeaderCandidate}.${kbPayloadCandidate}` :
  		this.vpBottomSigningContent;
  	const kb = this.extractPublicKeyFromSigningContent(kbSigningForExtraction, kbHeaderCandidate);
  	if (!this.kbJwtPublicKey && kb?.key) {
  		this.kbJwtPublicKey = kb.key;
  	}
  	this.kbJwtKeyId = kb?.id;
  	this.kbJwtAlg = kb?.alg;
  }

  private extractPublicKeyFromSigningContent (signingContent?: string, headerSegmentIfSeparated?: string): { key?: string, id?: string, alg?: string } | undefined {
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

  		const {alg} = headerJson;

  		if (headerJson.jwk) {
  			return { key: JSON.stringify(headerJson.jwk, null, 2), id: headerJson.kid, alg };
  		}
  		if (headerJson.x5c) {
  			return this.extractPublicKeyFromX5c(headerJson.x5c[0]);
  		}
  		if (headerJson.kid) {
  			return { id: String(headerJson.kid), alg };
  		}

  		if (payloadSegment) {
  			const payloadJson = this.base64UrlJsonDecode(payloadSegment);
  			const cnf = payloadJson?.cnf;
  			if (cnf) {
  				const cnfJwk = cnf.jwk;
  				const cnfJkt = cnf.jkt;
  				const cnfSpki = cnf.spki || cnf.spk || cnf.x5c?.[0];
  				const cnfKey = cnf.public_key || cnf.pub || cnf.pk || cnf.key;

  				if (cnfJwk) {
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

  private extractPublicKeyFromX5c (x5cBase64: string): { key: string, alg?: string } | undefined {
  	try {
  		const derBytes = this.decodeX5cBase64ToDer(x5cBase64);
  		const parsedKey = this.parseSubjectPublicKeyFromDer(derBytes);
  		if (!parsedKey) {
  			return undefined;
  		}
  		return {
  			key: this.wrapBytesInPem(parsedKey.spkiDer, 'PUBLIC KEY'),
  			alg: parsedKey.algorithmOid
  		};
  	} catch {
  		return undefined;
  	}
  }

  private base64UrlJsonDecode (segment: string): any | undefined {
  	try {
  		const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  		const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  		const decoded = atob(base64 + padding);
  		return JSON.parse(decoded);
  	} catch {
  		return undefined;
  	}
  }

  flatten (sharedAttestations: PresentedAttestation[]): (Single | Errored)[] {
  	const singles: (Single | Errored)[] = [];
  	sharedAttestations.forEach(it => {
  		switch (it.kind) {
  		case 'enveloped':
  			return singles.push(...it.attestations);
  		case 'single':
  			return singles.push(it);
  		case 'error':
  			return singles.push(it);
  		}
  	});
  	return singles;
  }

  isErrored (it: Single | Errored): it is Errored {
  	return it.kind === 'error' as const;
  }

  viewContents (attestation: Single) {
  	this.dialog.open(ViewAttestationComponent, {
  		data: {
  			attestation: attestation
  		},
  		height: '70%',
  		width: '60%',
  	});
  }

  openLogs () {
  	this.dialog.open(OpenLogsComponent, {
  		data: {
  			transactionId: this.concludedTransaction.transactionId,
  			label: 'Show Logs',
  			isInspectLogs: false
  		},
  	});
  }

  private formatPublicKeyInOpenSSLStandard (base64Key: string): string {
  	const standardBase64 = base64Key.replace(/-/g, '+').replace(/_/g, '/');
  	const remainder = standardBase64.length % 4;
  	const paddedKey = remainder > 0 ? standardBase64 + '='.repeat(4 - remainder) : standardBase64;

  	const lines: string[] = [];
  	for (let i = 0; i < paddedKey.length; i += 64) {
  		lines.push(paddedKey.substring(i, i + 64));
  	}

  	return lines.join('\n');
  }

  private base64ToRawBytes (base64String: string): Uint8Array {
  	if (!base64String || typeof base64String !== 'string') {
  		return new Uint8Array(0);
  	}

  	const standardBase64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
  	const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  	if (!base64Regex.test(standardBase64)) {
  		return new Uint8Array(0);
  	}

  	const paddedBase64 = standardBase64 + '='.repeat((4 - (standardBase64.length % 4)) % 4);
  	try {
  		const binaryString = atob(paddedBase64);
  		const bytes = new Uint8Array(binaryString.length);
  		for (let i = 0; i < binaryString.length; i++) {
  			bytes[i] = binaryString.charCodeAt(i);
  		}
  		return bytes;
  	} catch {
  		return new Uint8Array(0);
  	}
  }

  private decodeX5cBase64ToDer (x5cBase64: string): Uint8Array {
  	const trimmed = (x5cBase64 || '').trim();
  	if (!trimmed) {
  		return new Uint8Array(0);
  	}
  	if (trimmed.includes('-----BEGIN')) {
  		return this.pemToDerUint8Array(trimmed);
  	}
  	const rawBytes = this.base64ToRawBytes(trimmed);
  	if (rawBytes.length === 0) {
  		return rawBytes;
  	}
  	if (rawBytes[0] !== 0x30) {
  		const ascii = this.uint8ArrayToBinaryString(rawBytes);
  		if (ascii.includes('-----BEGIN')) {
  			return this.pemToDerUint8Array(ascii);
  		}
  	}
  	return rawBytes;
  }

  private uint8ArrayToBinaryString (bytes: Uint8Array): string {
  	let result = '';
  	for (let i = 0; i < bytes.length; i += 0x8000) {
  		const chunk = bytes.subarray(i, i + 0x8000);
  		result += String.fromCharCode(...chunk);
  	}
  	return result;
  }

  async downloadPublicKey (type: 'sd-jwt' | 'kb-jwt'): Promise<void> {
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
  		const zip = new JSZip();

  		zip.file(`${prefix}-public-key.pem`, publicKey);

  		if (signature) {
  			const signatureBytes = this.base64ToRawBytes(signature);
  			zip.file(`${prefix}-signature.der`, signatureBytes);
  		}

  		if (signingContent) {
  			zip.file(`${prefix}-signing-content.txt`, signingContent);
  		}

  		const zipBlob = await zip.generateAsync({ type: 'blob' });
  		const url = window.URL.createObjectURL(zipBlob);
  		const link = document.createElement('a');
  		link.href = url;
  		link.download = `${prefix}-openssl-verification-files.zip`;
  		document.body.appendChild(link);
  		link.click();
  		document.body.removeChild(link);
  		window.URL.revokeObjectURL(url);

  	} catch (error) {
  		console.error(`Error creating ZIP for ${type}:`, error);
  	}
  }

  private safeParseJson (value: string): any | undefined {
  	try {
  		return JSON.parse(value);
  	} catch {
  		return undefined;
  	}
  }

  private hydrateKbPublicKeyFromAttestations (attestations: (Single | Errored)[]): void {
  	if (this.kbJwtPublicKey) {
  		return;
  	}

  	const candidate = attestations.find((item) => {
  		const format = (item as any)?.format;
  		return typeof format === 'string' && format.toUpperCase().includes('JWT');
  	}) as any;

  	const attributes = Array.isArray(candidate?.attributes) ? candidate.attributes : undefined;
  	if (!attributes) {
  		return;
  	}

  	const cnfAttr = attributes.find(
  		(attribute: any) => typeof attribute?.key === 'string' && attribute.key.toLowerCase() === 'cnf'
  	);
  	if (typeof cnfAttr?.value !== 'string') {
  		return;
  	}

  	const parsed = this.safeParseJson(cnfAttr.value);
  	const publicKeyBase64 = parsed?.jwk?.pub;
  	if (!publicKeyBase64) {
  		return;
  	}

  	const formattedKey = this.formatPublicKeyInOpenSSLStandard(publicKeyBase64);
  	this.kbJwtPublicKey = `-----BEGIN PUBLIC KEY-----
${formattedKey}
-----END PUBLIC KEY-----`;
  }

  private pemToDerUint8Array (pem: string): Uint8Array {
  	const base64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  	const binary = atob(base64);
  	const len = binary.length;
  	const bytes = new Uint8Array(len);
  	for (let i = 0; i < len; i++) {
  		bytes[i] = binary.charCodeAt(i);
  	}
  	return bytes;
  }

  private parseSubjectPublicKeyFromDer (bytes: Uint8Array): { algorithmOid: string; spkiDer: Uint8Array } | undefined {
  	const root = this.parseAsn1Node(bytes, 0);
  	if (!root || root.tag !== 0x30 || !root.children || root.children.length < 1) {
  		return undefined;
  	}

  	const tbsCertificate = root.children[0];
  	if (!tbsCertificate || tbsCertificate.tag !== 0x30 || !tbsCertificate.children) {
  		return undefined;
  	}

  	const spki = tbsCertificate.children.find(child => child.tag === 0x30 && child.children && child.children.length === 2 && child.children[1].tag === 0x03);
  	if (!spki || !spki.children) {
  		return undefined;
  	}

  	const algorithmSeq = spki.children[0];
  	const subjectPublicKeyBitString = spki.children[1];
  	if (!algorithmSeq.children || algorithmSeq.children.length === 0) {
  		return undefined;
  	}

  	const algorithmOidNode = algorithmSeq.children[0];
  	const algorithmOid = this.decodeObjectIdentifier(algorithmOidNode.value);
  	const spkiDer = bytes.slice(spki.offset, spki.end);

  	return { algorithmOid, spkiDer };
  }

  private parseAsn1Node (bytes: Uint8Array, offset: number): ParsedAsn1Node | undefined {
  	if (offset >= bytes.length) return undefined;

  	const tag = bytes[offset];
  	let length = bytes[offset + 1];
  	let lengthBytes = 1;
  	if (length & 0x80) {
  		const numLengthBytes = length & 0x7f;
  		length = 0;
  		for (let i = 0; i < numLengthBytes; i++) {
  			length = (length << 8) | bytes[offset + 2 + i];
  		}
  		lengthBytes += numLengthBytes;
  	}

  	const start = offset + 1 + lengthBytes;
  	const end = start + length;
  	const value = bytes.slice(start, end);

  	const node: ParsedAsn1Node = { tag, length, start, end, offset, value };

  	if ((tag & 0x20) === 0x20) {
  		let cursor = start;
  		node.children = [];
  		while (cursor < end) {
  			const child = this.parseAsn1Node(bytes, cursor);
  			if (!child) break;
  			node.children.push(child);
  			cursor = child.end;
  		}
  	}

  	return node;
  }

  private decodeObjectIdentifier (bytes: Uint8Array): string {
  	if (!bytes || bytes.length === 0) {
  		return 'unknown';
  	}
  	const numbers = [] as number[];
  	let value = 0;
  	let isFirst = true;
  	for (const byte of bytes) {
  		value = (value << 7) | (byte & 0x7f);
  		if ((byte & 0x80) === 0) {
  			if (isFirst) {
  				const first = Math.floor(value / 40);
  				const second = value % 40;
  				numbers.push(first, second);
  				isFirst = false;
  			} else {
  				numbers.push(value);
  			}
  			value = 0;
  		}
  	}
  	return numbers.join('.');
  }

  private wrapBytesInPem (bytes: Uint8Array, label: string): string {
  	const base64 = btoa(String.fromCharCode(...bytes));
  	const lines: string[] = [];
  	for (let i = 0; i < base64.length; i += 64) {
  		lines.push(base64.slice(i, i + 64));
  	}
  	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
  }

}
