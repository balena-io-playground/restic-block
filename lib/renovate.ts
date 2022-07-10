import {
	DATA_ROOT_DIR,
	BACKUP_OPTS,
	RESTORE_OPTS,
	PRUNE_OPTS,
	RESTIC_CACHE_DIR,
	RESTIC_REPOSITORY,
} from './config';
import {
	getStateStatus,
	stopServices,
	startServices,
	getLocalTargetState,
} from './supervisor';
import { logger } from './logger';
import { boolean } from 'boolean';
import { childProcess } from './spawn';
import { promises as fsPromises } from 'fs';

const prependExtraArgs = (args: string[], extra: string[]): string[] => {
	// put dry-run at the front of the extra args
	if (boolean(process.env.DRY_RUN)) {
		extra.unshift('--dry-run');
	}

	// append one level of verbosity
	if (logger.isInfoEnabled()) {
		extra.unshift('-v');
	}

	// append one more level of verbosity
	if (logger.isDebugEnabled()) {
		extra.unshift('-v');
	}

	// give the passed-in args the highest priority by appending them last
	return extra.concat(args);
};

const getExcludedVolumes = async (
	appId: string,
	serviceName: string,
): Promise<string[]> => {
	const targetState = await getLocalTargetState();

	const resticVolumes = targetState.state.local.apps[appId].services
		.find((f: any) => f.serviceName === serviceName)
		.config.volumes.filter((f: string) =>
			[RESTIC_CACHE_DIR, RESTIC_REPOSITORY].includes(f.split(':')[1]),
		)
		.map((m: string) => m.split(':').shift());

	const eligibleVolumes = Object.values(
		targetState.state.local.apps[appId].volumes,
	)
		.map((m: any) => [m.appId, m.name].join('_'))
		.filter((f) => !resticVolumes.includes(f));

	const allVolumes = (
		await fsPromises.readdir(DATA_ROOT_DIR, { withFileTypes: true })
	)
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name);

	return allVolumes.filter((f) => !eligibleVolumes.includes(f));
};

// https://restic.readthedocs.io/en/latest/040_backup.html
export const doBackup = async (args: string[] = []): Promise<string> => {
	args = prependExtraArgs(args, BACKUP_OPTS);

	if (
		process.env.BALENA_APP_ID != null &&
		process.env.BALENA_SERVICE_NAME != null
	) {
		const excludeVolumes = await getExcludedVolumes(
			process.env.BALENA_APP_ID,
			process.env.BALENA_SERVICE_NAME,
		);
		args = prependExtraArgs(
			args,
			excludeVolumes.map(
				(m: any) => '--exclude=' + [DATA_ROOT_DIR, m].join('/'),
			),
		);
	}

	return childProcess('sh', [
		'-c',
		'--',
		`restic init 2>/dev/null || true`,
	]).then(() => {
		return childProcess('sh', [
			'-c',
			'--',
			`restic backup ${DATA_ROOT_DIR} ${args.join(' ')} | cat`,
		]);
	});
};

// https://restic.readthedocs.io/en/latest/050_restore.html
export const doRestore = async (args: string[] = ['latest']): Promise<void> => {
	args = prependExtraArgs(args, RESTORE_OPTS);

	let services = [];
	let fnPre = (..._args: any) => Promise.resolve();
	let fnPost = (..._args: any) => Promise.resolve();

	if (process.env.BALENA_APP_ID != null) {
		services = await getStateStatus().then((state) =>
			state.containers
				.filter((f: any) => f.serviceName !== process.env.BALENA_SERVICE_NAME)
				.map((m: any) => m.serviceName),
		);

		fnPre = stopServices.bind(null, process.env.BALENA_APP_ID, services);
		fnPost = startServices.bind(null, process.env.BALENA_APP_ID, services);
	}

	return fnPre()
		.then(() => {
			return childProcess('sh', [
				'-c',
				'--',
				`restic restore --target=${DATA_ROOT_DIR} ${args.join(' ')} | cat`,
			]);
		})
		.then(() => {
			return fnPost();
		});
};

// https://restic.readthedocs.io/en/latest/060_forget.html
export const doPrune = async (args: string[] = []): Promise<string> => {
	args = prependExtraArgs(args, PRUNE_OPTS);

	return childProcess('restic', ['forget', '--prune', ...args]);
};
