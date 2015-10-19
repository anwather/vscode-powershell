/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');

import PowershellService = require('./powershellService');
import PowerShellDef = require("./powerShellDef");
//import ExtraInfoSupport = require('./features/extraInfoSupport');
import CommentsSupport = require('./features/commentsSupport');
import OccurrencesSupport = require('./features/occurrencesSupport');
import ParameterHintsSupport = require('./features/parameterHintsSupport');
import BufferSyncSupport = require('./features/bufferSyncSupport');
import SuggestSupport = require('./features/suggestSupport');
import Configuration = require('./features/configuration');
import DeclarationSupport = require('./features/declarationSupport');
import ReferenceSupport = require('./features/referenceSupport');
import NavigateTypeSupport = require('./features/navigateTypesSupport');

import Proto = require('./protocol');
import PowershellServiceClient = require('./powershellServiceClient');

export function activate(subscriptions: vscode.Disposable[]): void {
	var MODE_ID = 'PowerShell';
	var clientHost = new PowershellServiceClientHost();
	var client = clientHost.serviceClient;
	
	subscriptions.push(
		vscode.Modes.registerMonarchDefinition('PowerShell', PowerShellDef.language));

	vscode.Modes.TokenTypeClassificationSupport.register(MODE_ID, {
		wordDefinition: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\=\+\[\{\]\}\\\|\;\'\"\,\.\<\>\/\?\s]+)/g
	});
	vscode.Modes.ElectricCharacterSupport.register(MODE_ID, {
		brackets: [
			{ tokenType:'delimiter.curly.ts', open: '{', close: '}', isElectric: true },
			{ tokenType:'delimiter.square.ts', open: '[', close: ']', isElectric: true },
			{ tokenType:'delimiter.paren.ts', open: '(', close: ')', isElectric: true }
		],
		docComment: { scope:'comment.documentation', open:'/**', lineStart:' * ', close:' */' }
	});
	vscode.Modes.CharacterPairSupport.register(MODE_ID, {
		autoClosingPairs: [
			{ open: '{', close: '}' },
			{ open: '[', close: ']' },
			{ open: '(', close: ')' },
			{ open: '"', close: '"', notIn: ['string'] },
			{ open: '\'', close: '\'', notIn: ['string', 'comment'] }
		]
	});

	//vscode.languages.registerHoverProvider(MODE_ID, new ExtraInfoSupport(client));
	vscode.Modes.CommentsSupport.register(MODE_ID, new CommentsSupport());
	//vscode.languages.registerDefinitionProvider(MODE_ID, new DeclarationSupport(client));
	//vscode.languages.registerDocumentHighlightProvider(MODE_ID, new OccurrencesSupport(client));
	vscode.Modes.DeclarationSupport.register(MODE_ID, new DeclarationSupport(client));
	vscode.Modes.OccurrencesSupport.register(MODE_ID, new OccurrencesSupport(client));	
	vscode.Modes.ParameterHintsSupport.register(MODE_ID, new ParameterHintsSupport(client));
	//vscode.languages.registerReferenceProvider(MODE_ID, new ReferenceSupport(client));
	//vscode.languages.registerWorkspaceSymbolProvider(new NavigateTypeSupport(client, MODE_ID));
	vscode.Modes.ReferenceSupport.register(MODE_ID, new ReferenceSupport(client));
	vscode.Modes.NavigateTypesSupport.register(MODE_ID, new NavigateTypeSupport(client, MODE_ID));	

	clientHost.addBufferSyncSupport(new BufferSyncSupport(client, MODE_ID));

	var suggestSupport = new SuggestSupport(client);
	vscode.Modes.SuggestSupport.register(MODE_ID, suggestSupport);
	
	Configuration.load(MODE_ID).then((config) => {
		suggestSupport.setConfiguration(config);
	});
}

class PowershellServiceClientHost implements PowershellService.IPowershellServiceClientHost {

	private client: PowershellServiceClient;

	private syntaxDiagnostics: {[key:string]:vscode.Diagnostic[];};
	private currentDiagnostics: { [key: string]: vscode.Disposable };
	private bufferSyncSupports: BufferSyncSupport[];
	
	constructor() {
		this.bufferSyncSupports = [];
		let handleProjectCreateOrDelete = () => {
			this.client.execute('reloadProjects', null, false);
			this.triggerAllDiagnostics();
		};
		let handleProjectChange = () => {
			this.triggerAllDiagnostics();
		}

        // TODO: Set this up for psm1/psd1 files?		
		//let watcher = vscode.workspace.createFileSystemWatcher('**/tsconfig.json');
		//watcher.onDidCreate(handleProjectCreateOrDelete);
		//watcher.onDidDelete(handleProjectCreateOrDelete);
		//watcher.onDidChange(handleProjectChange);

		this.client = new PowershellServiceClient(this);
		this.syntaxDiagnostics = Object.create(null);
		this.currentDiagnostics = Object.create(null);
	}

	public addBufferSyncSupport(support: BufferSyncSupport): void {
		this.bufferSyncSupports.push(support);
	}

	private triggerAllDiagnostics() {
		this.bufferSyncSupports.forEach(support => support.requestAllDiagnostics());
	}

	public get serviceClient(): PowershellServiceClient {
		return this.client;
	}

	/* internal */ syntaxDiagnosticsReceived(event:Proto.DiagnosticEvent):void {
		var body = event.body;
		if (body.diagnostics) {
			var markers = this.createMarkerDatas(body.file, body.diagnostics);
			this.syntaxDiagnostics[body.file] = markers;
		}
	}

	/* internal */ semanticDiagnosticsReceived(event:Proto.DiagnosticEvent):void {
		var body = event.body;
		if (body.diagnostics) {
			var diagnostics = this.createMarkerDatas(body.file, body.diagnostics);
			var syntaxMarkers = this.syntaxDiagnostics[body.file];
			if (syntaxMarkers) {
				delete this.syntaxDiagnostics[body.file];
				diagnostics = syntaxMarkers.concat(diagnostics);
			}
			this.currentDiagnostics[body.file] && this.currentDiagnostics[body.file].dispose();
			this.currentDiagnostics[body.file] = vscode.languages.addDiagnostics(diagnostics);
		}
	}
	
	private createMarkerDatas(fileName: string, diagnostics: Proto.Diagnostic[]): vscode.Diagnostic[] {
		let result: vscode.Diagnostic[] = [];
		for (let diagnostic of diagnostics) {
			let uri = vscode.Uri.file(fileName);
			let {start, end, text} = diagnostic;
			//let range = new vscode.Range(start.line - 1, start.offset - 1, end.line - 1, end.offset - 1);
			let range = new vscode.Range(start.line, start.offset, end.line, end.offset);			
			let location = new vscode.Location(uri, range);

			result.push(new vscode.Diagnostic(diagnostic.severity, location, text, 'powershell'));
		}
		return result;
	}	

	// private createMarkerDatas(diagnostics:Proto.Diagnostic[]):vscode.Services.IMarkerData[] {
	// 	var markers: vscode.Services.IMarkerData[] = [];
	// 	for (var i = 0; i < diagnostics.length; i++) {
	// 		var diagnostic = diagnostics[i];
	// 		var marker:vscode.Services.IMarkerData = {
	// 			severity: diagnostic.severity,
	// 			message: diagnostic.text,
	// 			startLineNumber: diagnostic.start.line,
	// 			startColumn: diagnostic.start.offset,
	// 			endLineNumber: diagnostic.end.line,
	// 			endColumn : diagnostic.end.offset
	// 		};
	// 		markers.push(marker);
	// 	}
	// 	return markers;
	// }
}
