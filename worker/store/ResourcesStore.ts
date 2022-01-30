import { customAlphabet } from 'nanoid';
import { json } from 'remix';
import { createLogger } from '../logging';
import {
	scrapeHTML,
	getPageDetails,
	checkSafeBrowsingAPI,
	getIntegrations,
	getIntegrationsFromPage,
} from '../scraping';
import type {
	Env,
	Page,
	Resource,
	ResourceSummary,
	ResourceMetadata,
	SubmissionStatus,
	AsyncReturnType,
} from '../types';

/**
 * ID Generator based on nanoid
 * Using alphabets and digits only
 */
const generateId = customAlphabet(
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
	12,
);

async function createResourceStore(state: DurableObjectState, env: Env) {
	const { PAGE, CONTENT, GOOGLE_API_KEY } = env;
	const resourceIdByURL =
		(await state.storage.get<Record<string, string | undefined>>(
			'index/URL',
		)) ?? {};
	const resourceIdByPackageName =
		(await state.storage.get<Record<string, string | undefined>>(
			'index/PackageName',
		)) ?? {};

	async function createResource(
		page: Page,
		userId: string,
	): Promise<{
		id: string | null;
		status: SubmissionStatus;
	}> {
		if (!page.isSafe) {
			return {
				id: null,
				status: 'INVALID',
			};
		}

		const id = generateId();
		const now = new Date().toISOString();

		await updateResource(
			{
				id,
				url: page.url,
				bookmarked: [],
				viewCounts: 0,
				createdAt: now,
				createdBy: userId,
				updatedAt: now,
				updatedBy: userId,
			},
			page,
		);

		if (page.category === 'package') {
			resourceIdByPackageName[page.title] = id;
			state.storage.put('index/PackageName', resourceIdByPackageName);
		}

		return {
			id,
			status: 'PUBLISHED',
		};
	}

	async function getResource(resourceId: string) {
		const resource = await state.storage.get<ResourceSummary>(resourceId);

		if (!resource) {
			return null;
		}

		return {
			id: resource.id,
			url: resource.url,
			bookmarked: resource.bookmarked,
			viewCounts: resource.viewCounts,
			createdAt: resource.createdAt,
			createdBy: resource.createdBy,
			updatedAt: resource.updatedAt,
			updatedBy: resource.updatedBy,
		};
	}

	async function updateResource(
		resource: ResourceSummary,
		page?: Page,
	): Promise<void> {
		await state.storage.put(resource.id, resource);
		await updateResourceCache(resource, page);
	}

	async function updateResourceCache(
		summary: ResourceSummary,
		pageData?: Page,
	): Promise<void> {
		const page = pageData ?? (await PAGE.get<Page>(summary.url, 'json'));

		if (!page) {
			throw new Error('No page data found for the corresponding URL');
		}

		const packages = Object.keys(resourceIdByPackageName);
		const integrations =
			page.category === 'package' || page.category === 'repository'
				? getIntegrations(page.configs ?? [], packages, page.dependencies ?? {})
				: getIntegrationsFromPage(page, packages);
		const resource: Resource = {
			...summary,
			category: page.category,
			author: page.author,
			title: page.title,
			description: page.description,
			image: page.image,
			video: page.video,
			isSafe: page.isSafe,
			dependencies: page.dependencies,
			configs: page.configs,
			integrations,
		};
		const metadata: ResourceMetadata = {
			id: resource.id,
			url: resource.url,
			category: resource.category,
			author: resource.author,
			title: resource.title,
			description: resource.description?.slice(0, 80),
			viewCounts: resource.viewCounts,
			bookmarkCounts: resource.bookmarked.length,
			integrations: resource.integrations,
			createdAt: resource.createdAt,
		};

		await CONTENT.put(`resources/${resource.id}`, JSON.stringify(resource), {
			metadata,
		});
	}

	return {
		async submit(userId: string, url: string) {
			let status: SubmissionStatus | null = null;
			let page = await PAGE.get<Page>(url, 'json');

			if (!page) {
				page = await scrapeHTML(url, env.USER_AGENT);

				const [pageDetails, isSafe] = await Promise.all([
					getPageDetails(page.url, env),
					GOOGLE_API_KEY
						? checkSafeBrowsingAPI([page.url], GOOGLE_API_KEY)
						: true,
				]);
				const now = new Date().toISOString();

				page = {
					...page,
					...pageDetails,
					isSafe,
					createdAt: now,
					updatedAt: now,
				};

				PAGE.put(page.url, JSON.stringify(page));
			}

			let id = resourceIdByURL[page.url] ?? null;

			if (!id) {
				const result = await createResource(page, userId);

				id = result.id;
				status = result.status;

				if (id) {
					resourceIdByURL[page.url] = id;
					state.storage.put('index/URL', resourceIdByURL);
				}
			} else {
				status = 'RESUBMITTED';
			}

			return { id, status };
		},
		async refresh(userId: string, resourceId: string) {
			let resource = await getResource(resourceId);

			if (!resource) {
				return false;
			}

			const [currentPage, updatedPage, pageMetadata, isSafe] =
				await Promise.all([
					PAGE.get<Page>(resource.url, 'json'),
					scrapeHTML(resource.url, env.USER_AGENT),
					getPageDetails(resource.url, env),
					GOOGLE_API_KEY
						? checkSafeBrowsingAPI([resource.url], GOOGLE_API_KEY)
						: true,
				]);

			const now = new Date().toISOString();
			const page = {
				...updatedPage,
				...pageMetadata,
				isSafe,
				createdAt: currentPage?.createdAt ?? resource.createdAt ?? now,
				updatedAt: now,
			};

			PAGE.put(page.url, JSON.stringify(page));

			if (resource.url !== page.url) {
				PAGE.put(resource.url, JSON.stringify(page));

				resource = {
					...resource,
					url: page.url,
					updatedAt: now,
					updatedBy: userId,
				};
			}

			await updateResource(resource, page);

			return true;
		},
		async getDetails(resourceId: string | null) {
			const resource = resourceId ? await getResource(resourceId) : null;

			if (!resource) {
				return null;
			}

			updateResourceCache(resource);

			return resource;
		},
		async view(resourceId: string | null) {
			const resource = resourceId ? await getResource(resourceId) : null;

			if (!resource) {
				return false;
			}

			updateResource({
				...resource,
				viewCounts: resource.viewCounts + 1,
			});

			return true;
		},
		async bookmark(userId: string, resourceId: string | null) {
			const resource = resourceId ? await getResource(resourceId) : null;

			if (!resource) {
				return false;
			}

			let bookmarked = resource.bookmarked ?? [];

			if (!bookmarked.includes(userId)) {
				bookmarked = bookmarked.concat(userId);
			}

			if (bookmarked !== resource.bookmarked) {
				updateResource({ ...resource, bookmarked });
			}

			return true;
		},
		async unbookmark(userId: string, resourceId: string | null) {
			const resource = resourceId ? await getResource(resourceId) : null;

			if (!resource) {
				return false;
			}

			let bookmarked = resource.bookmarked ?? [];

			if (bookmarked.includes(userId)) {
				bookmarked = bookmarked.filter((id) => id !== userId);
			}

			if (bookmarked !== resource.bookmarked) {
				updateResource({ ...resource, bookmarked });
			}

			return true;
		},
	};
}

/**
 * ResourcesStore - A durable object that keeps resources data and preview info
 */
export class ResourcesStore {
	env: Env;
	state: DurableObjectState;
	store: AsyncReturnType<typeof createResourceStore> | null;

	constructor(state: DurableObjectState, env: Env) {
		this.env = env;
		this.state = state;
		this.store = null;
		state.blockConcurrencyWhile(async () => {
			this.store = await createResourceStore(state, env);
		});
	}

	async fetch(request: Request) {
		const logger = createLogger(request, {
			...this.env,
			LOGGER_NAME: 'store:ResourcesStore',
		});

		let response = new Response('Not found', { status: 404 });

		try {
			let url = new URL(request.url);
			let method = request.method.toUpperCase();

			if (!this.store) {
				throw new Error('');
			} else if (url.pathname === '/submit' && method === 'POST') {
				const { url, userId } = await request.json();
				const result = await this.store.submit(userId, url);

				response = json(result, 201);
			} else if (url.pathname === '/refresh' && method === 'POST') {
				const { userId, resourceId } = await request.json();
				const success = await this.store.refresh(userId, resourceId);

				if (success) {
					response = new Response('OK', { status: 200 });
				}
			} else if (url.pathname === '/details' && method === 'GET') {
				const resourceId = url.searchParams.get('resourceId');
				const resource = await this.store.getDetails(resourceId);

				if (resource) {
					response = json(resource);
				}
			} else if (url.pathname === '/view' && method === 'PUT') {
				const { resourceId } = await request.json();
				const success = await this.store.view(resourceId);

				if (success) {
					response = new Response('OK', { status: 200 });
				}
			} else if (url.pathname === '/bookmark' && method === 'PUT') {
				const { userId, resourceId } = await request.json();
				const success = await this.store.bookmark(userId, resourceId);

				if (success) {
					response = new Response('OK', { status: 200 });
				}
			} else if (url.pathname === '/bookmark' && method === 'DELETE') {
				const { userId, resourceId } = await request.json();
				const success = await this.store.unbookmark(userId, resourceId);

				if (success) {
					response = new Response('OK', { status: 200 });
				}
			} else if (url.pathname === '/backup' && method === 'POST') {
				const data = await this.state.storage.list();

				response = json(Object.fromEntries(data));
			} else if (url.pathname === '/restore' && method === 'POST') {
				const data = await request.json();

				await this.state.storage.put(data as Record<string, any>);

				// Re-initialise everything again
				this.store = await createResourceStore(this.state, this.env);

				response = new Response('OK', { status: 200 });
			}
		} catch (e) {
			if (e instanceof Error) {
				logger.error(e);
				logger.log(
					`ResourcesStore failed while handling fetch - ${request.url}; Received message: ${e.message}`,
				);
			}

			response = new Response('Internal Server Error', { status: 500 });
		} finally {
			logger.report(response);
		}

		return response;
	}
}
