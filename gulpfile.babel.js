/**
 * External dependencies
 */
import check from 'gulp-check';
import colors from 'ansi-colors';
import del from 'del';
import deleteLines from 'gulp-delete-lines';
import eslint from 'gulp-eslint';
import fs from 'fs';
import gulp from 'gulp';
import i18n_calypso from 'i18n-calypso/cli';
import jshint from 'gulp-jshint';
import json_transform from 'gulp-json-transform';
import log from 'fancy-log';
import phplint from 'gulp-phplint';
import phpunit from 'gulp-phpunit';
import po2json from 'gulp-po2json';
import rename from 'gulp-rename';
import request from 'request';
import tap from 'gulp-tap';
import { spawn } from 'child_process';

/**
 * Internal dependencies
 */
const meta = require( './package.json' );

import { alwaysIgnoredPaths } from './tools/builder/util';

import frontendcss from './tools/builder/frontend-css';
import admincss from './tools/builder/admin-css';
import {
    watch as react_watch,
    build as react_build
} from './tools/builder/react';
import {
    watch as sass_watch,
    build as sass_build
} from './tools/builder/sass';

gulp.task( 'old-styles:watch', function() {
	return gulp.watch( 'scss/**/*.scss', gulp.parallel( 'old-styles' ) );
} );

/*
	"Check" task
	Search for strings and fail if found.
 */
gulp.task( 'check:DIR', function() {
	// __DIR__ is not available in PHP 5.2...
	return gulp.src( [ '*.php', '**/*.php', ...alwaysIgnoredPaths ] )
		.pipe( check( '__DIR__' ) )
		.on( 'error', function( err ) {
			log( colors.red( err ) );
		} );
} );

/*
	PHP Lint
 */
gulp.task( 'php:lint', function() {
	return gulp.src( [ '*.php', '**/*.php', ...alwaysIgnoredPaths ] )
		.pipe( phplint( '', { skipPassedFiles: true } ) );
} );

/*
	PHP Unit
 */
gulp.task( 'php:unit', function() {
	return gulp.src( 'phpunit.xml.dist' )
		.pipe( phpunit( 'phpunit', { colors: 'disabled' } ) )
		.on( 'error', function( err ) {
			log( colors.red( err ) );
		} );
} );

/**
 * eslint
 */
gulp.task( 'eslint', function() {
	return gulp.src( [
		'_inc/client/**/*.js',
		'_inc/client/**/*.jsx',
		'!_inc/client/**/test/*.js',
		'modules/**/*.jsx',
	] )
		.pipe( eslint() )
		.pipe( eslint.format() )
		.pipe( eslint.failAfterError() );
} );

/*
	JS Hint
 */
gulp.task( 'js:hint', function() {
	return gulp.src( [
		'_inc/*.js',
		'modules/*.js',
		'modules/**/*.js',
		'!_inc/*.min.js',
		'!modules/*.min.',
		'!modules/**/*.min.js',
		'!**/*/*block.js',
	] )
		.pipe( jshint( '.jshintrc' ) )
		.pipe( jshint.reporter( 'jshint-stylish' ) )
		.pipe( jshint.reporter( 'fail' ) );
} );

/*
	I18n land
*/

// Should not be run independently, run gulp languages instead
gulp.task( 'languages:get', function( callback ) {
	const process = spawn(
		'php',
		[
			'tools/export-translations.php',
			'.',
			'https://translate.wordpress.org/projects/wp-plugins/jetpack/dev'
		]
	);

	process.stderr.on( 'data', function( data ) {
		log( data.toString() );
	} );
	process.stdout.on( 'data', function( data ) {
		log( data.toString() );
	} );
	process.on( 'exit', function( code ) {
		if ( 0 !== code ) {
			log( 'Failed getting languages: process exited with code ', code );
			// Make the task fail if there was a problem as this could mean that we were going to ship a Jetpack version
			// with the languages not properly built
			return callback( new Error() );
		}
		callback();
	} );
} );

// Should not be run independently, run gulp languages instead
gulp.task( 'languages:build', function( done ) {
	const terms = [];

	// Defining global that will be used from jetpack-strings.js
	global.$jetpack_strings = [];
	global.array = function() {};

	// Plural gettext call doesn't make a difference for Jed, the singular value is still used as the key.
	global.__ = global._n = function( term ) {
		terms[ term ] = '';
	};

	// Context prefixes the term and is separated with a unicode character U+0004
	global._x = function( term, context ) {
		terms[ context + '\u0004' + term ] = '';
	};

	gulp.src( [ '_inc/jetpack-strings.php' ] )
		.pipe( deleteLines( {
			filters: [ /<\?php/ ]
		} ) )
		.pipe( rename( 'jetpack-strings.js' ) )
		.pipe( gulp.dest( '_inc' ) )
		.on( 'end', function() {
			// Requiring the file that will call __, _x and _n
			require( './_inc/jetpack-strings.js' );

			return gulp.src( [ 'languages/*.po' ] )
				.pipe( po2json( {
					format: 'jed1.x',
					domain: 'jetpack',
				} ) )
				.pipe( json_transform( function( data ) {
					const localeData = data.locale_data.jetpack;
					const filtered = {
						'': localeData[ '' ]
					};

					Object.keys( localeData ).forEach( function( term ) {
						if ( terms.hasOwnProperty( term ) ) {
							filtered[ term ] = localeData[ term ];

							// Having a &quot; in the JSON might cause errors with the JSON later
							if ( typeof filtered[ term ] === 'string' ) {
								filtered[ term ] = filtered[ term ].replace( '&quot;', '\"' );
							}
						}
					} );

					return filtered;
				} ) )
				.pipe( gulp.dest( 'languages/json/' ) )
				.on( 'end', function() {
					fs.unlinkSync( './_inc/jetpack-strings.js' );
					done();
				} );
		} );
} );

gulp.task( 'php:module-headings', function( callback ) {
	const process = spawn(
		'php',
		[
			'tools/build-module-headings-translations.php'
		]
	);

	process.stderr.on( 'data', function( data ) {
		log( data.toString() );
	} );
	process.stdout.on( 'data', function( data ) {
		log( data.toString() );
	} );
	process.on( 'exit', function( code ) {
		if ( 0 !== code ) {
			log( 'Failed building module headings translations: process exited with code ', code );
		}
		callback();
	} );
} );

// Should not be run independently, run gulp languages instead
gulp.task( 'languages:cleanup', function( done ) {
	const language_packs = [];

	request(
		'https://api.wordpress.org/translations/plugins/1.0/?slug=jetpack&version=' + meta.version,
		function( error, response, body ) {
			if ( error || 200 !== response.statusCode ) {
				done( 'Failed to reach wordpress.org translation API: ' + error );
			}

			body = JSON.parse( body );

			body.translations.forEach( function( language ) {
				language_packs.push( './languages/jetpack-' + language.language + '.*' );
			} );

			log( 'Cleaning up languages for which Jetpack has language packs:' );
			del( language_packs ).then( function( paths ) {
				paths.forEach( function( item ) {
					log( item );
				} );
				done();
			} );
		}
	);
} );

gulp.task( 'languages:extract', function( done ) {
	const paths = [];

	gulp.src( [
		'_inc/client/**/*.js',
		'_inc/client/**/*.jsx',
		'_inc/blocks/*.js',
		'_inc/blocks/**/*.js'
	] )
		.pipe( tap( function( file ) {
			paths.push( file.path );
		} ) )
		.on( 'end', function() {
			i18n_calypso( {
				projectName: 'Jetpack',
				inputPaths: paths,
				output: '_inc/jetpack-strings.php',
				phpArrayName: 'jetpack_strings',
				format: 'PHP',
				textdomain: 'jetpack',
				keywords: [ 'translate', '__', '_n', '_x', '_nx' ]
			} );

			done();
		} );
} );

/*
 * Gutenberg Blocks for Jetpack
 */
gulp.task( 'gutenberg:blocks', function() {
	return gulp.src( [ 'node_modules/@automattic/jetpack-blocks/build/**/*' ] )
		.pipe( gulp.dest( '_inc/blocks' ) );
} );

gulp.task( 'old-styles', gulp.parallel( frontendcss, admincss, 'sass:old' ) );
gulp.task( 'jshint', gulp.parallel( 'js:hint' ) );
gulp.task( 'php', gulp.parallel( 'php:lint', 'php:unit' ) );
gulp.task( 'checkstrings', gulp.parallel( 'check:DIR' ) );

// Default task
gulp.task(
	'default',
	gulp.parallel( react_build, sass_build, 'old-styles', 'checkstrings', 'php:lint', 'js:hint', 'php:module-headings', 'gutenberg:blocks' )
);
gulp.task(
	'watch',
	gulp.parallel( react_watch, sass_watch, 'old-styles:watch' )
);

// Keeping explicit task names to allow for individual runs
gulp.task( 'sass:build', sass_build );
gulp.task( 'react:build', react_build );
gulp.task( 'sass:watch', sass_watch );
gulp.task( 'react:watch', react_watch );

gulp.task(
	'languages',
	gulp.parallel(
		gulp.series( 'languages:get', 'languages:build', 'languages:cleanup' ),
		'languages:extract'
	)
);
