import {Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse, HttpHeaders, HttpParams, HttpRequest} from '@angular/common/http';
import {EMPTY, forkJoin, Observable, ObservableInput, throwError} from 'rxjs';

import {ProjectService} from 'src/app/features/project/project.service';
import {SnackService} from 'src/app/core/snack/snack.service';

import {GitlabCfg} from '../gitlab';
import {GitlabOriginalComment, GitlabOriginalIssue} from './gitlab-api-responses';
import {HANDLED_ERROR_PROP_STR} from 'src/app/app.constants';
import {GITLAB_API_BASE_URL} from '../gitlab.const';
import {T} from 'src/app/t.const';
import {catchError, filter, flatMap, map, share, switchMap, take} from 'rxjs/operators';
import {GitlabIssue} from '../gitlab-issue/gitlab-issue.model';
import {mapGitlabIssue, mapGitlabIssueToSearchResult} from '../gitlab-issue/gitlab-issue-map.util';
import {SearchResultItem} from '../../../issue.model';

const BASE = GITLAB_API_BASE_URL;

@Injectable({
  providedIn: 'root',
})
export class GitlabApiService {
  /** @deprecated */
  private _header: HttpHeaders;

  constructor(
    private _projectService: ProjectService,
    private _snackService: SnackService,
    private _http: HttpClient,
  ) {
  }

  getProjectData$(cfg: GitlabCfg): Observable<GitlabIssue[]> {
    if (!this._isValidSettings(cfg)) {
      return EMPTY;
    }
    return this._getProjectIssues$(1, cfg).pipe(
      flatMap(
        issues => forkJoin([
          ...issues.map(issue => this.getIssueWithComments$(issue, cfg))
        ])
      ),
    );
  }

  getById$(id: number, cfg: GitlabCfg): Observable<GitlabIssue> {
    return this.getProjectData$(cfg)
      .pipe(switchMap(issues => {
        return issues.filter(issue => issue.id === id);
      }));
  }

  getIssueWithComments$(issue: GitlabIssue, cfg: GitlabCfg): Observable<GitlabIssue> {
    return this._getIssueComments$(issue.id, 1, cfg).pipe(
      map((comments) => {
          return {
            ...issue,
            comments,
            commentsNr: comments.length,
          };
        }
      ));
  }

  searchIssueInProject$(searchText: string, cfg: GitlabCfg): Observable<SearchResultItem[]> {
    const filterFn = issue => {
      try {
        return issue.title.toLowerCase().match(searchText.toLowerCase())
          || issue.body.toLowerCase().match(searchText.toLowerCase());
      } catch (e) {
        console.warn('RegEx Error', e);
        return false;
      }
    };
    if (!this._isValidSettings(cfg)) {
      return EMPTY;
    }
    return this.getProjectData$(cfg)
      .pipe(
        // a single request should suffice
        share(),
        map((issues: GitlabIssue[]) =>
          issues.filter(filterFn)
            .map(mapGitlabIssueToSearchResult)
        ),
      );
  }

  closeIssue(issueId: number, cfg: GitlabCfg): Observable<GitlabIssue> {
    return this._sendRequest$({
      url: `${BASE}/${cfg.project}/issues/${issueId}?state_event=close`,
      method: 'PUT'
    }, cfg).pipe(
      take(1),
      map((issue: GitlabOriginalIssue) => {
        return mapGitlabIssue(issue);
      }),
    );
  }

  reopenIssue(issueId: number, cfg: GitlabCfg): Observable<GitlabIssue> {
    return this._sendRequest$({
      url: `${BASE}/${cfg.project}/issues/${issueId}?state_event=reopen`,
      method: 'PUT'
    }, cfg).pipe(
      take(1),
      map((issue: GitlabOriginalIssue) => {
        return mapGitlabIssue(issue);
      }),
    );
  }

  private _getProjectIssues$(pageNumber: number, cfg: GitlabCfg): Observable<GitlabIssue[]> {
    return this._sendRequest$({
      url: `${BASE}/${cfg.project}/issues?order_by=updated_at&per_page=100&page=${pageNumber}`
    }, cfg).pipe(
      take(1),
      map((issues: GitlabOriginalIssue[]) => {
        return issues ? issues.map(mapGitlabIssue) : [];
      }),
    );
  }

  private _getIssueComments$(issueid: number, pageNumber: number, cfg: GitlabCfg) {
    if (!this._isValidSettings(cfg)) {
      return EMPTY;
    }
    return this._sendRequest$({
      url: `${BASE}/${cfg.project}/issues/${issueid}/notes?per_page=100&page=${pageNumber}`,
    }, cfg).pipe(
      map((comments: GitlabOriginalComment[]) => {
        return comments ? comments : [];
      }),
    );
  }

  private _isValidSettings(cfg: GitlabCfg): boolean {
    if (cfg && cfg.project && cfg.project.length > 0) {
      return true;
    }
    this._snackService.open({
      type: 'ERROR',
      msg: T.F.GITLAB.S.ERR_NOT_CONFIGURED
    });
    return false;
  }


  private _sendRequest$(params: HttpRequest<string> | any, cfg: GitlabCfg): Observable<any> {
    this._isValidSettings(cfg);

    const p: HttpRequest<any> | any = {
      ...params,
      method: params.method || 'GET',
      headers: {
        ...(cfg.token ? {Authorization: 'Bearer ' + cfg.token} : {}),
        ...(params.headers ? params.headers : {}),
      }
    };

    const bodyArg = params.data
      ? [params.data]
      : [];

    const allArgs = [...bodyArg, {
      headers: new HttpHeaders(p.headers),
      params: new HttpParams({fromObject: p.params}),
      reportProgress: false,
      observe: 'response',
      responseType: params.responseType,
    }];
    const req = new HttpRequest(p.method, p.url, ...allArgs);
    return this._http.request(req).pipe(
      // TODO remove type: 0 @see https://brianflove.com/2018/09/03/angular-http-client-observe-response/
      filter(res => !(res === Object(res) && res.type === 0)),
      map((res: any) => (res && res.body)
        ? res.body
        : res),
      catchError(this._handleRequestError$.bind(this)),
    );
  }

  private _handleRequestError$(error: HttpErrorResponse, caught: Observable<object>): ObservableInput<{}> {
    console.error(error);
    if (error.error instanceof ErrorEvent) {
      // A client-side or network error occurred. Handle it accordingly.
      this._snackService.open({
        type: 'ERROR',
        msg: T.F.GITLAB.S.ERR_NETWORK,
      });
    } else {
      // The backend returned an unsuccessful response code.
      this._snackService.open({
        type: 'ERROR',
        translateParams: {
          statusCode: error.status,
          errorMsg: error.error && error.error.message,
        },
        msg: T.F.GITLAB.S.ERR_NOT_CONFIGURED,
      });
    }
    if (error && error.message) {
      return throwError({[HANDLED_ERROR_PROP_STR]: 'Gitlab: ' + error.message});
    }
    return throwError({[HANDLED_ERROR_PROP_STR]: 'Gitlab: Api request failed.'});
  }
}
